/**
 * The one thing ompd writes into OMP's own MCP configuration, and the guard
 * that stops writing it from destroying the rest of the file.
 *
 * `~/.omp/agent/mcp.json` is a replace-whole-resource surface. There is no
 * partial-update API for it, only a file that is serialised in full on every
 * write. That makes two different harms possible, and they need two different
 * defences. A caller that wrote its own entries straight out would silently
 * delete every other server the operator had configured, which read-merge-write
 * fixes. A caller that read the file, thought for a while, and wrote it back
 * would silently delete whatever OMP's own `/mcp add` did in between, which
 * only a freshness token compared at write time fixes -- and on a mismatch the
 * current document comes back with the refusal, because a bare "stale" would
 * force the caller into a second round trip to learn what it already knew.
 *
 * What goes in is deliberately thin: a loopback URL and a header whose value is
 * a `!command`, OMP's own documented pre-connect indirection
 * (`omp://mcp-config.md`, "Pre-connect env/header resolution"). No credential
 * is ever in this file, so a config committed to a repository by accident
 * carries nothing and a support bundle that includes it leaks nothing.
 *
 * The second half of a brokered entry is the disable. OMP resolves duplicate
 * server names by first-definition-wins across sources, so leaving the
 * plugin- or tool-provided definition of the same server in place would mount a
 * second, unbrokered copy of it at a lower precedence -- the very copy whose
 * unrefreshable credential this subsystem exists to replace. `disabledServers`
 * is the highest-precedence denylist OMP offers, so the original name goes
 * there.
 *
 * Which names ompd put there is ompd's bookkeeping, and it lives in ompd's own
 * home rather than in `mcp.json`. A marker key inside the OMP config file would
 * be an unknown property in a file OMP validates against its own schema, and
 * the failure mode of tripping that validation is the whole file contributing
 * nothing.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { MCP_AUTH_HEADER } from "./proxy.ts";

/**
 * The OMP MCP config file, as far as this module is concerned.
 *
 * Everything is optional and the index signature is load bearing: the point of
 * this type is to carry keys this daemon has never heard of through a
 * read-merge-write untouched. A narrower type would type-check beautifully and
 * delete the operator's `enabledServers`.
 */
export interface OmpMcpConfigDoc {
  $schema?: string;
  mcpServers?: Record<string, unknown>;
  disabledServers?: string[];
  enabledServers?: string[];
  [key: string]: unknown;
}

/**
 * The header the loopback proxy reads, imported rather than retyped.
 *
 * Two spellings of one string is a bug with a delay on it: the config would
 * keep validating, the proxy would keep refusing, and the symptom would be a
 * 401 from a component that is working exactly as written.
 */
export { MCP_AUTH_HEADER };

/**
 * The reader the `!command` runs.
 *
 * Absolute, and a binary rather than a shell builtin, because a session started
 * by launchd inherits a `PATH` of whatever the plist says and nothing else.
 * `cat` resolved from a login shell's `PATH` is a header that works in a
 * terminal and silently resolves to nothing under the service manager, which
 * OMP then omits -- a 401 with no explanation anywhere.
 */
export const CALLER_AUTH_READER = "/bin/cat";

/** One brokered server, as the caller asks for it. */
export interface BrokeredServerEntry {
  /** The name the loopback entry is mounted under. */
  brokerName: string;
  /**
   * The name the unbrokered definition of this server uses. It goes into
   * `disabledServers`; without that, OMP mounts both.
   */
  originalName: string;
  /** Stable derived grant id. The last path segment of the loopback endpoint. */
  grantId: string;
  /** The port the daemon's loopback proxy is listening on. */
  port: number;
  /** Absolute path to the loopback caller-auth token. Read by the `!command`, never inlined. */
  tokenPath: string;
}

export type ApplyResult =
  | { written: true; token: string; disabled: string[] }
  | { written: false; reason: "stale"; current: OmpMcpConfigDoc; token: string };

export type RemoveResult =
  | { written: true; token: string; removed: string[]; skipped: string[] }
  | { written: false; reason: "stale"; current: OmpMcpConfigDoc; token: string };

/** Where the ownership side table lives, so a test never writes to the real daemon home. */
export interface OwnershipOptions {
  /** Defaults to `<ompd home>/mcp-auth-config.json`. */
  ownershipPath?: string;
  env?: Record<string, string | undefined>;
}

/** One brokered entry ompd is responsible for removing again. */
export interface OwnedServer {
  originalName: string;
  grantId: string;
}

/**
 * What ompd wrote, so it can take exactly that back out.
 *
 * `disabled` is keyed by original name rather than tracked per brokered entry,
 * and that is the whole design of this table rather than an implementation
 * detail. A disable is a claim on a *name*: two brokered entries can depend on
 * the same one, and the second one to arrive finds it already there. Recording
 * "this entry added it" would make that second entry look like it inherited
 * someone else's disable, and removing the first would then release a disable
 * the second still needs -- an unbrokered copy of the server quietly coming
 * back with its unrefreshable credential. Keyed by name, the claim is held
 * until nothing ompd owns references it.
 *
 * The other half is the operator. A name they disabled themselves, months
 * before ompd existed, is never entered here, so it is never released.
 */
export interface OwnershipDoc {
  version: 1;
  servers: Record<string, OwnedServer>;
  disabled: Record<string, true>;
}

/**
 * What a name may contain, in the two places it appears, and why they differ.
 *
 * A `disabledServers` entry is a string in an array whose only job is to equal
 * a name OMP already resolved, so it has to accept whatever OMP accepted.
 * Measured rather than assumed: this machine's resolved set contains
 * `vendor-api:Vendor Edge` -- a colon *and* a space -- because
 * plugin-provided config keys are not held to the config writer's own pattern.
 * A stricter rule here does not protect anything; it just refuses to disable
 * the definition that most needs disabling. Control characters are the real
 * constraint, since the value is written into a JSON document.
 *
 * A brokered entry is a property name under `mcpServers`, so it stays inside
 * what OMP's bundled schema will validate: an editor reporting an error on a
 * key ompd put there is a support question ompd created.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const SERVER_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/;
const SERVER_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** A grant id is a URL path segment, so it is held to path-segment characters. */
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Characters a path may contain to be safe as a bare word in a shell command.
 *
 * OMP runs everything after the `!` through a shell. A token path with a space,
 * a quote, a `$` or a `;` in it would either resolve to the wrong file or run
 * something nobody asked for, and this module is the last place that can tell.
 */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./@+-]+$/;

/**
 * Where OMP's user-level MCP config actually is.
 *
 * `PI_CONFIG_DIR` moves OMP's whole config root, and a named profile moves the
 * user scope inside it (`~/.omp/profiles/<name>/agent/mcp.json`). Both matter
 * for the same reason: writing to `~/.omp/agent/mcp.json` while OMP is running
 * out of somewhere else puts the brokered entry in a file no session will ever
 * read, and the only symptom is that nothing changed.
 */
export function ompMcpConfigPath(opts: { env?: Record<string, string | undefined>; profile?: string } = {}): string {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const configRoot = env.PI_CONFIG_DIR || join(env.HOME || homedir(), ".omp");
  const profile = opts.profile || env.OMP_PROFILE || env.PI_PROFILE;
  if (profile === undefined || profile === "" || profile === "default") return join(configRoot, "agent", "mcp.json");
  return join(configRoot, "profiles", profile, "agent", "mcp.json");
}

/** Where the ownership side table lives by default. */
export function ownershipPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.OMPD_HOME || join(env.HOME || homedir(), ".ompd"), "mcp-auth-config.json");
}

/**
 * Read the config and the token that says which bytes were read.
 *
 * The token hashes the raw file bytes rather than the reserialised document, so
 * a change that JSON round-tripping would erase -- key order, indentation, a
 * trailing newline someone's editor added -- still counts as a change. It has
 * to: the question the token answers is "is this the file I merged against",
 * and any byte difference means something wrote it.
 *
 * A file that is present but not parseable throws rather than reading as empty.
 * Reading a broken file as `{}` and then writing the merge would replace the
 * operator's config with three brokered entries and nothing else.
 */
export function readOmpMcpConfig(path: string): { doc: OmpMcpConfigDoc; token: string } {
  if (!existsSync(path)) return { doc: {}, token: "v1:absent" };
  const raw = readFileSync(path);
  const token = `v1:${createHash("sha256").update(raw).digest("hex")}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    // Deliberately not including the parse error or any of the file: a config
    // file can hold an `Authorization` header the operator pasted in by hand.
    throw new Error(`${path} is not valid JSON; refusing to merge into it`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return { doc: parsed as OmpMcpConfigDoc, token };
}

/**
 * Add or update the brokered entries, preserving everything else.
 *
 * `token` is the one from the read this caller merged against. The re-read here
 * is not a redundant second read of the same bytes; it is the only thing that
 * can notice an `/mcp add` that landed in between, and on a mismatch nothing is
 * written at all.
 */
export function applyBrokeredServers(
  path: string,
  entries: readonly BrokeredServerEntry[],
  token: string,
  opts: OwnershipOptions = {},
): ApplyResult {
  const claimed = new Set<string>();
  for (const entry of entries) {
    validateEntry(entry);
    if (claimed.has(entry.brokerName)) throw new Error(`two brokered entries claim the name ${entry.brokerName}`);
    claimed.add(entry.brokerName);
  }

  const fresh = readOmpMcpConfig(path);
  if (fresh.token !== token) {
    return { written: false, reason: "stale", current: fresh.doc, token: fresh.token };
  }

  const ownPath = opts.ownershipPath ?? ownershipPath(opts.env);
  const owned = readOwnership(ownPath);
  const servers = readServers(path, fresh.doc);
  const disabled = readDisabled(path, fresh.doc);

  // Someone else's server under our name is not ours to replace. The same
  // discipline the extension installer applies at its target path, for the same
  // reason: this file is the operator's, and guessing wrong destroys a
  // definition only they can reconstruct.
  //
  // The second check is about ompd's own names. Re-applying an owned name is
  // routine -- a port change, a re-authorization of the same account -- and the
  // grant id is stable across both because it derives from the resource URL and
  // the account. An owned name arriving with a *different* grant id is not an
  // update, it is a collision, and the way to produce one is to mint broker
  // names by sanitizing the original: `a:b` and `a-b` both become `a-b`. Taking
  // it would repoint the name at the second grant and leave the first with an
  // ownership record, a disable, and no route. Remove it first, deliberately.
  for (const entry of entries) {
    const claim = owned.servers[entry.brokerName];
    if (claim === undefined) {
      if (entry.brokerName in servers) {
        throw new Error(`${path} already defines a server named ${entry.brokerName} that ompd did not write`);
      }
      continue;
    }
    if (claim.grantId !== entry.grantId) {
      throw new Error(
        `${entry.brokerName} is already brokering grant ${claim.grantId}; remove it before pointing it at ` +
          `${entry.grantId}`,
      );
    }
  }

  const newlyDisabled: string[] = [];
  const nextOwned: OwnershipDoc = { version: 1, servers: { ...owned.servers }, disabled: { ...owned.disabled } };
  for (const entry of entries) {
    servers[entry.brokerName] = renderBrokeredServer(entry);
    if (!disabled.includes(entry.originalName)) {
      disabled.push(entry.originalName);
      nextOwned.disabled[entry.originalName] = true;
      newlyDisabled.push(entry.originalName);
    }
    nextOwned.servers[entry.brokerName] = { originalName: entry.originalName, grantId: entry.grantId };
  }

  // Ownership before the config, on purpose. If the config write then fails,
  // the table claims entries that are not in the file, and removing them is a
  // no-op -- `disabledServers` removal only touches names that are present, and
  // a failed apply left none. The other order can disable the operator's server
  // and leave no record of who did it, which is a repair only a human can make.
  writeOwnership(ownPath, nextOwned);
  const next = mergeDoc(fresh.doc, servers, disabled);
  return { written: true, token: writeConfig(path, next), disabled: newlyDisabled };
}

/**
 * Take the brokered entries back out, and only them.
 *
 * A name the ownership table does not claim is left exactly where it is and
 * reported as skipped. Deleting it because a caller named it would make this
 * function a way to remove any server in the file.
 */
export function removeBrokeredServers(
  path: string,
  brokerNames: readonly string[],
  token: string,
  opts: OwnershipOptions = {},
): RemoveResult {
  const fresh = readOmpMcpConfig(path);
  if (fresh.token !== token) {
    return { written: false, reason: "stale", current: fresh.doc, token: fresh.token };
  }

  const ownPath = opts.ownershipPath ?? ownershipPath(opts.env);
  const owned = readOwnership(ownPath);
  const servers = readServers(path, fresh.doc);
  const disabled = readDisabled(path, fresh.doc);

  const removed: string[] = [];
  const skipped: string[] = [];
  const nextOwned: OwnershipDoc = { version: 1, servers: { ...owned.servers }, disabled: {} };
  for (const name of brokerNames) {
    if (!(name in owned.servers)) {
      skipped.push(name);
      continue;
    }
    delete servers[name];
    delete nextOwned.servers[name];
    removed.push(name);
  }

  // A claimed disable outlives the entry that first needed it and is released
  // only once nothing ompd still owns references the name. A claim with nothing
  // left referencing it is released even if this call did not name its entry:
  // that is the repair path for an apply that wrote the table and then failed to
  // write the config, and the alternative is a disable nobody can account for.
  const stillNeeded = new Set(Object.values(nextOwned.servers).map(server => server.originalName));
  const released = new Set<string>();
  for (const name of Object.keys(owned.disabled)) {
    if (stillNeeded.has(name)) nextOwned.disabled[name] = true;
    else released.add(name);
  }
  const nextDisabled = disabled.filter(name => !released.has(name));

  writeOwnership(ownPath, nextOwned);
  const next = mergeDoc(fresh.doc, servers, nextDisabled);
  return { written: true, token: writeConfig(path, next), removed, skipped };
}

/** What ompd currently claims to have written. */
export function readOwnership(path: string): OwnershipDoc {
  if (!existsSync(path)) return { version: 1, servers: {}, disabled: {} };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const doc = parsed as { version?: unknown; servers?: unknown; disabled?: unknown };
  if (doc.version !== 1) {
    throw new Error(`${path} has ownership format ${String(doc.version)}; this build understands 1`);
  }
  const servers: Record<string, OwnedServer> = {};
  if (doc.servers !== null && typeof doc.servers === "object" && !Array.isArray(doc.servers)) {
    for (const [name, value] of Object.entries(doc.servers as Record<string, unknown>)) {
      const row = value as Partial<OwnedServer>;
      if (typeof row?.originalName !== "string" || typeof row.grantId !== "string") continue;
      servers[name] = { originalName: row.originalName, grantId: row.grantId };
    }
  }
  const disabled: Record<string, true> = {};
  if (doc.disabled !== null && typeof doc.disabled === "object" && !Array.isArray(doc.disabled)) {
    for (const [name, value] of Object.entries(doc.disabled as Record<string, unknown>)) {
      if (value === true) disabled[name] = true;
    }
  }
  return { version: 1, servers, disabled };
}

/**
 * The entry itself: a loopback URL, and a header that is a command.
 *
 * Exported because the loopback proxy's route and this URL have to agree on the
 * grant id, and a second place spelling out `/mcp/<id>` is a second place to
 * get it wrong.
 */
export function renderBrokeredServer(entry: BrokeredServerEntry): Record<string, unknown> {
  return {
    type: "http",
    url: `http://127.0.0.1:${entry.port}/mcp/${entry.grantId}`,
    headers: { [MCP_AUTH_HEADER]: `!${CALLER_AUTH_READER} ${entry.tokenPath}` },
  };
}

function validateEntry(entry: BrokeredServerEntry): void {
  if (!SERVER_KEY_PATTERN.test(entry.brokerName)) {
    throw new Error(`${entry.brokerName} is not a usable name for an mcpServers key`);
  }
  if (!SERVER_NAME_PATTERN.test(entry.originalName)) {
    throw new Error(`${entry.originalName} is not a usable MCP server name`);
  }
  if (entry.brokerName === entry.originalName) {
    // The disable is by name and outranks everything, so a brokered entry
    // sharing the original's name would disable itself.
    throw new Error(`the brokered entry for ${entry.originalName} must not reuse the name it disables`);
  }
  if (!GRANT_ID_PATTERN.test(entry.grantId)) throw new Error(`${entry.grantId} is not a usable grant id`);
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
    throw new Error(`${String(entry.port)} is not a usable port`);
  }
  if (!isAbsolute(entry.tokenPath)) throw new Error("the caller-auth token path must be absolute");
  if (!SHELL_SAFE_PATH.test(entry.tokenPath)) {
    throw new Error("the caller-auth token path contains characters a shell would not read literally");
  }
}

function readServers(path: string, doc: OmpMcpConfigDoc): Record<string, unknown> {
  const value = doc.mcpServers;
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} has an mcpServers that is not an object; refusing to merge into it`);
  }
  return { ...(value as Record<string, unknown>) };
}

function readDisabled(path: string, doc: OmpMcpConfigDoc): string[] {
  const value = doc.disabledServers;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(name => typeof name !== "string")) {
    throw new Error(`${path} has a disabledServers that is not a string array; refusing to merge into it`);
  }
  return [...(value as string[])];
}

/**
 * Rebuild the document with the two keys this daemon touches replaced in place.
 *
 * Iterating the current keys is what keeps `$schema` first and keeps every key
 * ompd knows nothing about exactly where the operator left it. A diff of this
 * file after an apply should show the brokered entries and nothing else.
 */
function mergeDoc(current: OmpMcpConfigDoc, servers: Record<string, unknown>, disabled: string[]): OmpMcpConfigDoc {
  const next: Record<string, unknown> = {};
  let sawServers = false;
  let sawDisabled = false;
  for (const [key, value] of Object.entries(current)) {
    if (key === "mcpServers") {
      next[key] = servers;
      sawServers = true;
      continue;
    }
    if (key === "disabledServers") {
      next[key] = disabled;
      sawDisabled = true;
      continue;
    }
    next[key] = value;
  }
  if (!sawServers) next.mcpServers = servers;
  // An absent `disabledServers` that would still be empty stays absent. A
  // present one stays present even when it empties out, because its presence is
  // part of the shape the operator wrote.
  if (!sawDisabled && disabled.length > 0) next.disabledServers = disabled;
  return next as OmpMcpConfigDoc;
}

/**
 * Replace the file, atomically, keeping a copy of what was there.
 *
 * Temp file in the same directory so the rename cannot cross a filesystem and
 * degrade into a copy, `wx` so a leftover temp from a crashed run is never
 * silently appended to, and `rmSync` in a `finally` so a failed write leaves no
 * debris for the next one to trip over. The `.bak` is taken once per apply
 * rather than per entry: it is the previous state of the file, and there is only
 * one of those.
 */
function writeConfig(path: string, doc: OmpMcpConfigDoc): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  const existed = existsSync(path);
  if (existed) copyFileSync(path, `${path}.bak`);
  const mode = existed ? statSync(path).mode & 0o777 : 0o600;
  const temp = join(dirname(path), `.${randomUUID()}.mcp.json.tmp`);
  try {
    writeFileSync(temp, body, { mode, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return `v1:${createHash("sha256").update(body).digest("hex")}`;
}

function writeOwnership(path: string, doc: OwnershipDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.mcp-auth-config.json.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
