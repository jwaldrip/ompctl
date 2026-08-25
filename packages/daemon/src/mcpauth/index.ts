/**
 * The MCP auth broker, composed.
 *
 * Five pieces with one owner: a vault that keeps refresh material off the
 * database file, a store that rotates it atomically, a broker that is the only
 * thing on this machine allowed to redeem it, a loopback listener that hands
 * sessions a live access token they never see the source of, and a bridge that
 * points OMP's own MCP config at that listener.
 *
 * Everything a client can reach goes through {@link McpAuthCatalog}, whose
 * methods return identifiers and states. There is no method here that returns
 * a token, which is what makes "no route leaks a credential" a property of the
 * type rather than a habit of the routes.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpAuthState, McpAuthStatus, McpAuthSummary } from "@ompd/core";
import type { McpAuthApplyReport, McpAuthCatalog, McpAuthImportReport } from "../gateway/gateway.ts";
import { McpAuthBrokerImpl } from "./broker.ts";
import { discoverAuth } from "./discovery.ts";
import { deriveGrantId, detectRunningOmpAuthBroker, importGrants, planImport, readOmpCredentials } from "./import.ts";
import { beginLogin, type PendingLogin } from "./login.ts";
import {
  applyBrokeredServers,
  type BrokeredServerEntry,
  ompMcpConfigPath,
  ownershipPath,
  readOmpMcpConfig,
  readOwnership,
  removeBrokeredServers,
} from "./omp-config.ts";
import { listOmpRemoteServers, mintBrokerNames, normalizeMcpUrl } from "./omp-servers.ts";
import { type McpAuthProxy, startMcpAuthProxy } from "./proxy.ts";
import { McpAuthStore } from "./store.ts";
import { HttpTokenEndpointClient } from "./token-endpoint.ts";
import { type Clock, systemClock, type VaultBackend } from "./types.ts";
import { openVault } from "./vault.ts";

export interface McpAuthOptions {
  /** Daemon state directory, `~/.ompd`. */
  home: string;
  /** Loopback port for the broker listener. 0 leaves the subsystem off. */
  port: number;
  /** OMP's user MCP config. Defaults to the active profile's `mcp.json`. */
  ompConfigPath?: string;
  /** OMP's credential store, for `import`. Defaults to the active profile's `agent.db`. */
  ompAgentDbPath?: string;
  /**
   * Force the vault's at-rest backend instead of probing for the strongest one.
   *
   * A seam of the same kind as `spawnHost` and `spawnAwake`: it exists so a
   * test never writes an item into the operator's real login keychain, and so
   * the Linux path can be exercised on a Mac. The daemon does not set it.
   */
  vaultBackend?: VaultBackend;
  /** Where `loadAllMCPConfigs` resolves project-level MCP config from. Defaults to the daemon's cwd. */
  cwd?: string;
  clock?: Clock;
  onLog?: (line: string) => void;
}

/** How long an unfinished browser authorization stays claimable. */
const LOGIN_FLOW_TTL_MS = 300_000;

/**
 * One authorization someone has started but not yet finished in a browser.
 *
 * `settled` is recorded here rather than read off the flow, because the flow
 * exposes a promise and a poller needs an answer without awaiting one. The
 * promise's own handlers are the only writers, so the two cannot disagree.
 */
interface LoginFlowEntry {
  flow: PendingLogin;
  startedAt: number;
  serverName: string;
  settled?: { ok: true; grantId: string } | { ok: false; detail: string };
}

/**
 * The caller credential for the loopback listener.
 *
 * Minted once and reused across restarts, because the value is referenced from
 * OMP's MCP config by path rather than by value: rotating it every start would
 * be invisible to a session that had already resolved the header, and the
 * symptom would be a 401 from a component that is working. `0600` in the `0700`
 * daemon home, the same protection `~/.ompd/token` and `~/.ompd/id` get.
 */
function ensureProxyToken(home: string): { token: string; path: string } {
  const path = join(home, "mcp-auth.token");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) {
      // A file left group- or world-readable by an earlier bug is repaired
      // rather than tolerated: a credential is not protected by having once
      // been written correctly.
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
      return { token: existing, path };
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path };
}

export class McpAuthSubsystem implements McpAuthCatalog {
  readonly #home: string;
  readonly #port: number;
  readonly #cwd: string;
  readonly #clock: Clock;
  readonly #onLog: (line: string) => void;
  readonly #store: McpAuthStore;
  #listenError: string | undefined;
  readonly #broker: McpAuthBrokerImpl;
  readonly #vaultBackend: McpAuthStatus["vault"];
  readonly #proxyToken: { token: string; path: string };
  readonly #ompConfigPath: string;
  readonly #ompAgentDbPath: string;
  readonly #ownershipPath: string;
  /**
   * Authorizations someone has started but not yet finished in a browser.
   *
   * `settled` is recorded here rather than read off the flow, because the flow
   * exposes a promise and a poller needs an answer without awaiting one. The
   * promise's own handlers are what write it, so the two cannot disagree.
   */
  readonly #flows = new Map<string, LoginFlowEntry>();
  #proxy: McpAuthProxy | undefined;

  constructor(opts: McpAuthOptions) {
    this.#home = opts.home;
    this.#port = opts.port;
    this.#cwd = opts.cwd ?? process.cwd();
    this.#clock = opts.clock ?? systemClock;
    this.#onLog = opts.onLog ?? (() => {});
    this.#ompConfigPath = opts.ompConfigPath ?? ompMcpConfigPath();
    this.#ompAgentDbPath = opts.ompAgentDbPath ?? join(homedir(), ".omp", "agent", "agent.db");
    this.#ownershipPath = ownershipPath({ ...process.env, OMPD_HOME: opts.home });

    const vault = openVault(opts.home, opts.vaultBackend === undefined ? {} : { backend: opts.vaultBackend });
    this.#vaultBackend = vault.backend;
    this.#store = new McpAuthStore(join(opts.home, "mcp-auth.db"), vault);
    this.#broker = new McpAuthBrokerImpl({
      grants: this.#store,
      tokens: new HttpTokenEndpointClient(),
      clock: this.#clock,
      onLog: this.#onLog,
    });
    this.#proxyToken = ensureProxyToken(opts.home);
  }

  start(): void {
    if (this.#port === 0) {
      this.#onLog("mcp auth broker is off: mcpAuthPort is 0");
      return;
    }
    try {
      this.#proxy = startMcpAuthProxy({
        broker: this.#broker,
        grants: this.#store,
        port: this.#port,
        tokenHash: createHash("sha256").update(this.#proxyToken.token).digest("hex"),
        clock: this.#clock,
        onLog: this.#onLog,
      });
    } catch (err) {
      // Not fatal to the daemon, and not silent either. Binding somewhere else
      // would be the worst of both: every brokered entry already written into
      // MCP config names this port, so a daemon listening elsewhere is a set of
      // connectors that fail with no explanation. Recorded and reported.
      this.#listenError = `could not bind 127.0.0.1:${this.#port}: ${err instanceof Error ? err.message : String(err)}`;
      this.#onLog(`mcp auth broker did not start: ${this.#listenError}`);
      return;
    }
    this.#broker.start();
    this.#onLog(`mcp auth broker on http://127.0.0.1:${this.#proxy.port}, ${this.#store.list().length} grants`);
  }

  stop(): void {
    this.#broker.stop();
    this.#proxy?.close();
    this.#proxy = undefined;
    for (const [, entry] of this.#flows) entry.flow.cancel();
    this.#flows.clear();
    this.#store.close();
  }

  /** The loopback base URL, or undefined when the listener is not up. */
  get endpoint(): string | undefined {
    return this.#proxy === undefined ? undefined : `http://127.0.0.1:${this.#proxy.port}`;
  }

  /** The path a config entry's `!command` reads. */
  get tokenPath(): string {
    return this.#proxyToken.path;
  }

  status(): McpAuthStatus {
    const owned = readOwnership(this.#ownershipPath);
    const wiredGrants: Record<string, true> = {};
    for (const server of Object.values(owned.servers)) wiredGrants[server.grantId] = true;
    const grants: McpAuthSummary[] = this.#broker.summaries().map(summary => ({
      ...summary,
      wired: wiredGrants[summary.id] === true,
    }));
    return {
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
      ...(this.#listenError === undefined ? {} : { listenError: this.#listenError }),
      vault: this.#vaultBackend,
      grants,
    };
  }

  async beginLogin(input: {
    resourceUrl: string;
    name?: string;
  }): Promise<{ flowId: string; authorizationUrl: string }> {
    this.#reapFlows();
    const serverName = input.name ?? new URL(input.resourceUrl).hostname.replace(/\./g, "-");
    const flow = await beginLogin({ resourceUrl: input.resourceUrl, serverName, timeoutMs: LOGIN_FLOW_TTL_MS });
    const flowId = randomBytes(9).toString("base64url");
    const entry: LoginFlowEntry = { flow, startedAt: this.#clock.now(), serverName };
    this.#flows.set(flowId, entry);

    // The grant is saved by the flow's own completion rather than by whoever
    // polls, so a caller that walks away after authorizing in the browser still
    // ends up with a stored grant. A CLI that had to stay alive to receive the
    // credential would be a CLI that can lose one.
    void flow.completed
      .then(grant => {
        this.#store.save(grant);
        entry.settled = { ok: true, grantId: grant.id };
        this.#onLog(`mcp auth: authorized ${grant.serverName} as ${grant.id}`);
      })
      .catch((err: unknown) => {
        // The message, not the cause chain: a token endpoint that refuses can
        // put a code fragment or a token in its body, and this string is
        // handed to a client and written to a log.
        const detail = err instanceof Error ? err.message : "authorization failed";
        entry.settled = { ok: false, detail };
        this.#onLog(`mcp auth: authorization for ${serverName} failed: ${detail}`);
      });

    return { flowId, authorizationUrl: flow.authorizationUrl };
  }

  loginProgress(
    flowId: string,
  ): { state: "pending" | "complete" | "failed"; grantId?: string; serverName?: string; detail?: string } | undefined {
    const entry = this.#flows.get(flowId);
    if (entry === undefined) return undefined;
    const settled = entry.settled;
    if (settled === undefined) return { state: "pending", serverName: entry.serverName };
    if (settled.ok) return { state: "complete", grantId: settled.grantId, serverName: entry.serverName };
    return { state: "failed", serverName: entry.serverName, detail: settled.detail };
  }

  async refresh(
    grantId: string,
  ): Promise<{ outcome: "ok" | "definitive" | "transient"; state: McpAuthState; detail?: string }> {
    const outcome = await this.#broker.refreshNow(grantId);
    const state = this.#store.get(grantId)?.state ?? "reauth_required";
    if (outcome.kind === "ok") return { outcome: "ok", state };
    return { outcome: outcome.kind, state, detail: outcome.reason };
  }

  forget(grantId: string): boolean {
    this.#broker.invalidate(grantId);
    return this.#store.remove(grantId);
  }

  async importFromOmp(input: { dryRun: boolean; force: boolean }): Promise<McpAuthImportReport> {
    if (!input.force && (await detectRunningOmpAuthBroker())) {
      return { refused: "broker_running", dryRun: input.dryRun, imported: [], skipped: [] };
    }
    const plan = planImport(readOmpCredentials(this.#ompAgentDbPath));
    const skipped = [...plan.dropped, ...plan.notImportable].map(row => ({
      resourceUrl: row.resourceUrl,
      reason: row.reason,
    }));

    if (input.dryRun) {
      return {
        dryRun: true,
        imported: plan.imports.map(planned => ({
          grantId: deriveGrantId(planned.row.resourceUrl, planned.account),
          serverName: planned.serverName,
          resourceUrl: planned.row.resourceUrl,
          recoveredTokenUrl: planned.row.tokenUrl === undefined,
        })),
        skipped,
      };
    }

    const run = await importGrants(plan, {
      discover: discoverAuth,
      grants: this.#store,
      clock: this.#clock,
      force: input.force,
    });
    if (!run.ok) return { refused: "broker_running", dryRun: false, imported: [], skipped };

    const imported: McpAuthImportReport["imported"] = [];
    for (const outcome of run.outcomes) {
      if (outcome.ok) {
        imported.push({
          grantId: outcome.grantId,
          serverName: outcome.serverName,
          resourceUrl: outcome.resourceUrl,
          recoveredTokenUrl: outcome.tokenUrlRecovered,
        });
      } else {
        skipped.push({ resourceUrl: outcome.resourceUrl, reason: outcome.reason });
      }
    }
    return { dryRun: false, imported, skipped };
  }

  /**
   * Point OMP's MCP config at the broker.
   *
   * The name being shadowed is looked up rather than guessed: a grant's
   * identity is its resource URL, but `disabledServers` works on names, and
   * the name lives in whichever config source defined that server. A grant no
   * config currently defines is still wired up under a name derived from the
   * server itself, with nothing disabled, which is the honest answer for a
   * server the operator authorized here and has not yet mounted anywhere.
   */
  async apply(): Promise<McpAuthApplyReport> {
    const endpoint = this.#proxy;
    if (endpoint === undefined) throw new Error("the mcp auth broker is not listening; nothing to point config at");

    const configured = await listOmpRemoteServers(this.#cwd);
    const nameByUrl: Record<string, string> = {};
    for (const server of configured) nameByUrl[normalizeMcpUrl(server.url)] = server.name;

    // Only grants that can actually serve a request. Wiring a
    // `reauth_required` or `no_refresh_grant` grant would do real damage
    // rather than nothing: `apply` also writes the original server's name into
    // `disabledServers`, so it would take down a definition that works today
    // and put a 503 in its place. An unready grant is left exactly as it is,
    // reported as skipped, and picked up by the next apply once a person has
    // authorized it.
    const grants = this.#store.list().filter(g => g.state !== "reauth_required" && g.state !== "no_refresh_grant");
    const notReady = this.#store
      .list()
      .filter(g => g.state === "reauth_required" || g.state === "no_refresh_grant")
      .map(g => ({ serverName: g.serverName, state: g.state, detail: g.detail ?? "" }));
    const minted = mintBrokerNames(
      grants.map(grant => ({
        originalName: nameByUrl[normalizeMcpUrl(grant.resourceUrl)] ?? grant.serverName,
        grantId: grant.id,
      })),
    );

    const entries: BrokeredServerEntry[] = minted.map(entry => ({
      brokerName: entry.brokerName,
      originalName: entry.originalName,
      grantId: entry.grantId,
      port: endpoint.port,
      tokenPath: this.#proxyToken.path,
    }));

    const { token } = readOmpMcpConfig(this.#ompConfigPath);
    const result = applyBrokeredServers(this.#ompConfigPath, entries, token, { ownershipPath: this.#ownershipPath });
    if (!result.written) {
      throw new Error(`${this.#ompConfigPath} changed while this ran; nothing was written. Run apply again.`);
    }
    return {
      applied: entries.map(entry => ({
        serverName: entry.originalName,
        brokerName: entry.brokerName,
        url: endpoint.urlFor(entry.grantId),
      })),
      disabled: result.disabled,
      skipped: notReady,
    };
  }

  async unapply(): Promise<{ removed: string[] }> {
    const owned = readOwnership(this.#ownershipPath);
    const names = Object.keys(owned.servers);
    if (names.length === 0) return { removed: [] };
    const { token } = readOmpMcpConfig(this.#ompConfigPath);
    const result = removeBrokeredServers(this.#ompConfigPath, names, token, { ownershipPath: this.#ownershipPath });
    if (!result.written) {
      throw new Error(`${this.#ompConfigPath} changed while this ran; nothing was written. Run unapply again.`);
    }
    return { removed: result.removed };
  }

  /**
   * Forget flows nobody finished.
   *
   * A flow holds a loopback listener and a PKCE verifier, so an abandoned one
   * is both a port and a piece of half-finished credential state. The listener
   * times itself out; this is what stops the map growing.
   */
  #reapFlows(): void {
    const cutoff = this.#clock.now() - LOGIN_FLOW_TTL_MS;
    for (const [id, entry] of this.#flows) {
      if (entry.startedAt < cutoff) {
        entry.flow.cancel();
        this.#flows.delete(id);
      }
    }
  }
}
