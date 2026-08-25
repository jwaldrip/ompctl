/**
 * The daemon side of container model access, and the guest config it seeds.
 *
 * `ompd new <dir> --container` used to reach `idle` and then fail every prompt
 * with "No model selected". The two units under test here are what closes that
 * gap: `DaemonModelAccess`, which mints one scoped bearer per container against
 * a broker the daemon owns, and `guest-config.ts`, which writes the three files
 * that point the guest's omp at it. Neither may hand a guest a provider
 * credential, because a container agent has full unrestricted internet egress
 * and Apple `container` rejects `--cap-drop`, so anything reusable that reaches
 * a guest can be read out of its filesystem and used from anywhere, forever.
 *
 * What these tests are for, in the order the defects they guard were found:
 *
 * 1. Every unusable configuration must REFUSE. `grant` answering `null` is
 *    legal for `ModelAccessProvider` and it would end the provision, but it
 *    would end it with "not configured" instead of naming the key to flip, and
 *    a container that provisions with no model is the exact defect this seam
 *    exists to remove. Most assertions below are therefore about a rejected
 *    promise rather than a value, which is why `rejection` exists: a resolved
 *    `null` has to fail loudly and say what it resolved to.
 * 2. The endpoint a guest is handed must be built from the bridge plan, not
 *    read back off the `ModelGrant`. On the `host-alias` shape the address the
 *    broker binds and the address the guest must dial are different strings on
 *    purpose, so the grant's own endpoint is not merely stale there, it is
 *    wrong by construction: it would hand a Docker Desktop guest
 *    `http://127.0.0.1:<port>`, its own loopback, where nothing is listening.
 * 3. No token may reach a log line, an audit row or an error. One test
 *    exercises every path in the class and then searches every captured line
 *    and every audit detail for every token that was minted.
 * 4. The seeded guest home holds the bearer and nothing else. No `~/.omp`, no
 *    `agent.db`, no second copy of the bearer in `models.yml`, and the path
 *    baked into `models.yml` is the path inside the guest rather than the host
 *    temp directory that backs the mount.
 * 5. A credential must not ride out of a child process into the daemon's log.
 *    The last section drives the real `OmpAuthServices` over a fake `spawn` and
 *    proves the two halves of that separately: a value this daemon holds is
 *    removed by identity, and a value it does not hold is removed only if a
 *    pattern recognises it. The second half is a real gap and the test that
 *    demonstrates it is deliberate, because the comment in that module now says
 *    so and a claim nobody can fail is worth nothing.
 *
 * Nothing here spawns omp. For everything about `DaemonModelAccess`,
 * `OmpAuthServices` is injected as a fake, which is also what makes the "the
 * guest's bearer stops at the broker" assertion possible: the fake's upstream
 * bearer is a distinctive string, so the fake gateway can prove which
 * credential was forwarded. The last section is the one place the real
 * `OmpAuthServices` runs, and it runs over a fake `spawn` and two loopback
 * servers standing in for the children's health and catalog endpoints.
 *
 * The model broker, though, is real and really binds, because a bind refusal, a
 * peer check and a revocation observable as a 401 are most of what is under
 * test. It binds loopback: a real container network gateway such as
 * `192.168.65.1` is not an address a test host holds, and the `host-bridge`
 * shape cares that the bind address and the guest's address are the same
 * string, not what that string is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelBroker } from "../src/model-broker/broker.ts";
import { DaemonModelAccess, type ModelAccessAuditRow } from "../src/model-broker/model-access.ts";
import { type AuthServiceProcess, OmpAuthServices } from "../src/model-broker/omp-auth-services.ts";
import {
  GUEST_HOME_MOUNT,
  type GuestModelAccess,
  renderGuestConfigYml,
  renderGuestModelsYml,
  seedGuestHome,
} from "../src/provisioner/guest-config.ts";
import { type GuestBridge, ProvisionError } from "../src/provisioner/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A provider-qualified id of the shape the gateway's catalog actually matches. */
const MODEL = "anthropic/claude-haiku-4-5";

/**
 * The bind address every test uses, and the range the peer check is given.
 *
 * A real `host-bridge` gateway is an address the container runtime assigns, and
 * it exists on the host only while a container is running on that network. No
 * test host holds one, so loopback stands in. It is a faithful stand-in for
 * this shape because the property under test is that the bind address and the
 * guest's endpoint are the SAME string, plus that the network's own CIDR
 * reaches the broker as the peer range.
 */
const LOOPBACK = "127.0.0.1";
const LOOPBACK_CIDR = "127.0.0.0/8";

/** The name Docker Desktop injects into a guest, which is the `host-alias` shape. */
const DESKTOP_ALIAS = "host.docker.internal";

/**
 * The credential the broker forwards upstream.
 *
 * Distinctive so the fake gateway's record of what it was handed is a real
 * assertion: the guest's own bearer must stop at the broker, and the only way
 * to see that is to name both values and compare.
 */
const GATEWAY_BEARER = "gateway-bearer-that-no-guest-ever-sees";

/** Proves a 200 came from the fake gateway rather than from the broker itself. */
const UPSTREAM_MESSAGE_ID = "msg_from_the_fake_auth_gateway";

type HostBridge = Extract<GuestBridge, { kind: "host-bridge" }>;
type HostAlias = Extract<GuestBridge, { kind: "host-alias" }>;

/**
 * The slice of `OmpAuthServices` that `DaemonModelAccess` calls.
 *
 * `Pick` rather than a hand-written interface, so the compiler holds the fake to
 * the real signatures: if `ensure` starts answering something else, these tests
 * stop compiling instead of passing against a shape the daemon no longer has.
 * The cast at the construction site is unavoidable and is the only one here:
 * `OmpAuthServices` carries `#private` fields, so TypeScript brands it
 * nominally and nothing but an instance of it is ever assignable to it, however
 * completely these four methods are implemented.
 */
type AuthServicesSeam = Pick<OmpAuthServices, "ensure" | "gatewayBearer" | "status" | "close">;

class FakeAuthServices implements AuthServicesSeam {
  ensureCalls = 0;
  bearerCalls = 0;
  statusCalls = 0;
  closeCalls = 0;
  /** What `ensure` answers with: the fake gateway's origin, with no trailing slash. */
  gatewayUrl = "";
  /** Set to make `ensure` fail, which is the only way to reach the relayed-reason path. */
  ensureFailure: string | null = null;

  ensure(): Promise<{ gatewayUrl: string }> {
    this.ensureCalls += 1;
    if (this.ensureFailure !== null) return Promise.reject(new Error(this.ensureFailure));
    return Promise.resolve({ gatewayUrl: this.gatewayUrl });
  }

  gatewayBearer(): Promise<string> {
    this.bearerCalls += 1;
    return Promise.resolve(GATEWAY_BEARER);
  }

  status(): { brokerUrl: string | null; gatewayUrl: string | null; running: boolean } {
    this.statusCalls += 1;
    return { brokerUrl: null, gatewayUrl: null, running: false };
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

/** One request the fake gateway saw. `authorization` is the point of it. */
interface GatewayCall {
  path: string;
  authorization: string | null;
  model: unknown;
}

interface FakeGateway {
  /** `http://127.0.0.1:<port>`, no trailing slash: the broker appends the path itself. */
  origin: string;
  seen: GatewayCall[];
  stop(): Promise<void>;
}

/**
 * Stands in for omp's `auth-gateway` on loopback.
 *
 * It answers only the route the broker is allowed to forward, so a broker that
 * started rewriting paths would show up as a 404 rather than as a pass.
 */
function fakeGateway(): FakeGateway {
  const seen: GatewayCall[] = [];
  const server = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    fetch: async req => {
      const path = new URL(req.url).pathname;
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      const model = typeof body === "object" && body !== null && "model" in body ? body.model : null;
      seen.push({ path, authorization: req.headers.get("authorization"), model });
      if (path !== "/v1/messages") return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ id: UPSTREAM_MESSAGE_ID, usage: { input_tokens: 7, output_tokens: 11 } });
    },
  });
  return {
    origin: `http://${LOOPBACK}:${server.port}`,
    seen,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** What `issue` was actually asked for, which is how the peer check is proved. */
interface IssuedRecord {
  model: string;
  peerCidr: string | null;
}

interface Harness {
  access: DaemonModelAccess;
  /** The injected spare, so a revocation can be checked at the broker itself. */
  broker: ModelBroker;
  services: FakeAuthServices;
  gateway: FakeGateway;
  logs: string[];
  audit: ModelAccessAuditRow[];
  issued: IssuedRecord[];
  /** `<configDir>/agent/config.yml`, the path every resolution failure must name. */
  hostConfigPath: string;
  port: number;
  /** `http://127.0.0.1:<port>`: where the broker really listens in these tests. */
  brokerUrl: string;
  writeHostConfig(text: string): void;
  /**
   * Make the daemon's own audit or log sink throw.
   *
   * Both are supplied by the daemon, so a throw is a bug in its own wiring
   * rather than anything a container can cause. It is worth injecting anyway:
   * they are called after `issue` has already minted a bearer, so a throw that
   * merely propagated would leave a live credential the provisioner never saw
   * and can therefore never release.
   */
  breakSink(which: "audit" | "log", reason: string): void;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Reverse order, so a temp directory is removed after the instance holding it
  // has stopped writing, and drained rather than iterated: a cleanup that
  // throws must not leave the rest of them unrun.
  const pending = cleanups.splice(0, cleanups.length).reverse();
  const failures: unknown[] = [];
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new Error(`cleanup failed: ${failures.map(String).join("; ")}`);
});

async function harness(opts: { enabled?: boolean; model?: string; ownBroker?: boolean } = {}): Promise<Harness> {
  // Off unless a test turns it on. Read live by both sinks below rather than
  // captured, so a test can break them after construction.
  let brokenSink: { which: "audit" | "log"; reason: string } | null = null;
  const logs: string[] = [];
  const audit: ModelAccessAuditRow[] = [];
  const issued: IssuedRecord[] = [];
  const configDir = mkdtempSync(join(tmpdir(), "ompd-model-access-test-"));
  const gateway = fakeGateway();
  const services = new FakeAuthServices();
  services.gatewayUrl = gateway.origin;
  const port = await freePort();

  const broker = new ModelBroker({
    upstreamUrl: () => gateway.origin,
    upstreamBearer: () => services.gatewayBearer(),
    // Never throws, even when `breakSink` has broken the daemon's own sinks.
    // That is faithful rather than convenient: in production the only place a
    // broker's log sink comes from is `#brokerFor`, which wraps it so a throw
    // cannot travel back into a broker mid-operation, and a test seam that
    // threw here would be modelling a wiring the daemon does not have. The test
    // below reaches the wrapped sink by getting `DaemonModelAccess` to build its
    // own broker.
    onLog: line => {
      logs.push(line);
    },
  });
  // Wrapped rather than reimplemented, so what is recorded is exactly what the
  // real `issue` was called with. `peerCidr` is the whole point: a `null` there
  // turns the peer-address check off for the grant, and it is the one
  // confinement property this daemon knowingly gives up, so the tests have to
  // see the argument rather than infer it from behaviour that loopback cannot
  // distinguish.
  const issue = broker.issue.bind(broker);
  broker.issue = input => {
    issued.push({ model: input.model, peerCidr: input.peerCidr });
    return issue(input);
  };

  const access = new DaemonModelAccess({
    // Never spawned, because `services` below is injected. A path that cannot
    // exist is deliberate: if the injection ever stops taking, these tests fail
    // with a spawn error naming this string instead of quietly starting two real
    // omp children against the operator's own vault.
    ompPath: "/nonexistent/ompctl-test-omp",
    configDir,
    brokerPort: port,
    model: opts.model ?? MODEL,
    enabled: opts.enabled ?? true,
    onLog: line => {
      logs.push(line);
      if (brokenSink?.which === "log") throw new Error(brokenSink.reason);
    },
    onAudit: row => {
      audit.push(row);
      if (brokenSink?.which === "audit") throw new Error(brokenSink.reason);
    },
    services: services as unknown as OmpAuthServices,
    // Omitted when a test asks for `ownBroker`, so the first grant is served by
    // a broker `DaemonModelAccess` constructs itself. That is the only shape
    // production ever has, and the injected spare bypasses the sink wrapping
    // and the live gateway url wiring that go with it.
    broker: opts.ownBroker === true ? undefined : broker,
  });

  cleanups.push(async () => {
    // First, because `close` logs: a sink left broken would report as a
    // cleanup failure instead of as the assertion the test just made.
    brokenSink = null;
    await access.close();
    await broker.close();
    await gateway.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  return {
    access,
    broker,
    services,
    gateway,
    logs,
    audit,
    issued,
    hostConfigPath: join(configDir, "agent", "config.yml"),
    port,
    brokerUrl: `http://${LOOPBACK}:${port}`,
    writeHostConfig: text => {
      mkdirSync(join(configDir, "agent"), { recursive: true });
      writeFileSync(join(configDir, "agent", "config.yml"), text);
    },
    breakSink: (which, reason) => {
      brokenSink = { which, reason };
    },
  };
}

function hostBridge(overrides: Omit<Partial<HostBridge>, "kind"> = {}): HostBridge {
  return { kind: "host-bridge", gateway: LOOPBACK, cidr: LOOPBACK_CIDR, ...overrides };
}

function hostAlias(overrides: Omit<Partial<HostAlias>, "kind"> = {}): HostAlias {
  return { kind: "host-alias", hostname: DESKTOP_ALIAS, bindHost: LOOPBACK, ...overrides };
}

/**
 * A loopback port for a broker in these tests.
 *
 * Two constraints collide, and the obvious answer to them is wrong.
 * `brokerPort` is a fixed number in daemon config and `issue` refuses to name
 * an endpoint on port 0, because an ephemeral port is not knowable before the
 * bind completes; so a test has to choose a number up front. But choosing it by
 * opening a listener on port 0 and closing it again chooses a number the kernel
 * is then free to hand to the next asker, and the next asker is another harness
 * in this file or in one of the sibling test files running in the same process.
 * That is not theoretical: it cost a real failure. The close-and-rebind tests
 * below give their port up for a moment between the release and the second
 * grant, and a harness that had been handed the same number bound it in the gap,
 * so the grant failed with a bind error where the assertion wanted a refusal.
 *
 * So candidates come from a fixed band well below macOS's ephemeral range,
 * where `net.inet.ip.portrange.first` is 49152: nothing that asks the kernel for
 * a port can be given one of these, which takes every sibling file's port-zero
 * probe out of the picture entirely. A process-wide cursor means two harnesses
 * in one process can never be handed the same number, the start is offset by pid
 * so two `bun test` processes running at once mostly do not overlap either, and
 * each candidate is confirmed bindable before it is handed out so a port
 * something else on this machine already holds is skipped rather than assigned.
 */
const PORT_BAND_FIRST = 24_101;
const PORT_BAND_LAST = 24_999;
let portCursor = PORT_BAND_FIRST + (process.pid % 400);

async function freePort(): Promise<number> {
  for (;;) {
    if (portCursor > PORT_BAND_LAST) {
      throw new Error(`no test broker port is left in ${PORT_BAND_FIRST}-${PORT_BAND_LAST}`);
    }
    const candidate = portCursor;
    portCursor += 1;
    if (await bindableNow(candidate)) return candidate;
  }
}

/** Whether `port` can be bound on loopback right now. Released immediately: see above. */
async function bindableNow(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = createServer();
    probe.on("error", () => resolve(false));
    probe.listen(port, LOOPBACK, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * The error a call refused with.
 *
 * A helper rather than `expect(...).rejects.toThrow` because the property under
 * test in half this file is that `grant` REFUSES instead of answering `null`. A
 * resolved value has to fail the assertion and say what it resolved to, which
 * `rejects` cannot do.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  let resolved: unknown;
  try {
    resolved = await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error(`expected a refusal, but it resolved with ${JSON.stringify(resolved)}`);
}

/** The same, for the synchronous renderers. */
function refusal(fn: () => unknown): Error {
  let resolved: unknown;
  try {
    resolved = fn();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error(`expected a refusal, but it returned ${JSON.stringify(resolved)}`);
}

/** Indexed access under `noUncheckedIndexedAccess`, failing with what was recorded. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected ${what} at index ${index}, but only ${items.length} were recorded`);
  }
  return item;
}

interface BrokerReply {
  status: number;
  body: string;
}

/**
 * One turn as the guest would make it.
 *
 * The body is read to completion every time, because the broker hands its
 * concurrency slot to the response stream and gets it back when the body ends.
 */
async function callBroker(url: string, token: string, model: string): Promise<BrokerReply> {
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Whether anything is listening at all.
 *
 * Deliberately unauthenticated: a live broker answers 401 and a broker whose
 * listener has come down refuses the connection, so this separates "revoked"
 * from "gone" without needing a credential.
 */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await res.text();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers for the rendered guest config
// ---------------------------------------------------------------------------

function mapping(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${what} to parse as a YAML mapping, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${what} to parse as a YAML list, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Permission bits only, so a mode assertion cannot pass on the file type. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Every path under `root`, relative and sorted, so "nothing else is here" is one assertion. */
function tree(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      found.push(relative);
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
    }
  };
  walk(root, "");
  return found.sort();
}

const seeded: string[] = [];

afterEach(() => {
  for (const dir of seeded.splice(0, seeded.length)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DaemonModelAccess
// ---------------------------------------------------------------------------

describe("daemon model access", () => {
  test("being switched off is a refusal naming the config key, never a null grant", async () => {
    const h = await harness({ enabled: false });

    const err = await rejection(h.access.grant({ network: "ompd-net", bridge: hostBridge() }));

    expect(err.message).toContain("containerModelAccess");
    expect(err.message).toContain("disabled");
    expect(err.message).toContain("fail every prompt");
    const row = at(h.audit, 0, "an audit row");
    expect(row.action).toBe("model.grant");
    expect(row.outcome).toBe("error");
    expect(row.detail.model).toBe(MODEL);
    expect(row.detail.network).toBe("ompd-net");
    expect(String(row.detail.reason)).toContain("containerModelAccess");
    expect(h.audit).toHaveLength(1);
    // Nothing was minted and nothing was started, so a refusal here really is
    // the end of the provision rather than a grant nobody looked at.
    expect(h.issued).toEqual([]);
    expect(h.services.ensureCalls).toBe(0);
    // Teardown of a disabled daemon still runs, and must not throw.
    await h.access.activate({ bridge: hostBridge() });
  });

  test("an unsupported bridge fails closed and relays the runtime's reason verbatim", async () => {
    const h = await harness();
    const reason =
      "docker 29.4.0 on darwin keeps its bridge inside a virtual machine and `network inspect ompd-net` " +
      "reported gateway 192.168.65.1, which is not an address on this host. Set containerRuntime to " +
      "`container`, or run ompd on Linux.";

    const err = await rejection(h.access.grant({ network: "ompd-net", bridge: { kind: "unsupported", reason } }));

    // Verbatim, not wrapped: the runtime layer is the only thing that knows
    // which runtime it asked and what came back, and composing a second
    // sentence around that would bury the part that says what to do.
    expect(err.message).toBe(reason);
    expect(at(h.audit, 0, "an audit row").detail.reason).toBe(reason);
    expect(at(h.audit, 0, "an audit row").outcome).toBe("error");
    expect(h.issued).toEqual([]);
    expect(h.services.ensureCalls).toBe(0);

    // `activate` is unreachable through the provisioner once `grant` has
    // refused, and it must not put a listener up for a caller that ignored the
    // refusal.
    const bindErr = await rejection(h.access.activate({ bridge: { kind: "unsupported", reason } }));
    expect(bindErr.message).toContain("nothing to bind");
    expect(bindErr.message).toContain(reason);
  });

  test("the host-bridge shape grants on the network's own gateway with the peer check on", async () => {
    const h = await harness();
    const bridge = hostBridge();

    const granted = await h.access.grant({ network: "ompd-net", bridge });

    expect(Object.keys(granted).sort()).toEqual(["endpoint", "model", "token"]);
    expect(granted.endpoint).toBe(`http://${LOOPBACK}:${h.port}`);
    expect(granted.model).toBe(MODEL);
    // 32 random bytes as base64url. The width matters: it is the only thing
    // confining the broker on the shape where the peer check is unavailable.
    expect(granted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The network's own subnet reached the broker, so the peer check is on for
    // this grant and an address outside it is refused.
    expect(h.issued).toEqual([{ model: MODEL, peerCidr: LOOPBACK_CIDR }]);
    expect(h.logs.some(line => line.includes("the peer-address check is OFF"))).toBe(false);
    expect(at(h.audit, 0, "an audit row")).toEqual({
      action: "model.grant",
      outcome: "ok",
      detail: { model: MODEL, network: "ompd-net", bridge: "host-bridge" },
    });

    await h.access.activate({ bridge });
    expect(await answers(h.brokerUrl)).toBe(true);

    // Idempotent per bind address: a second container on the same network finds
    // the address already bound and does nothing.
    await h.access.activate({ bridge });
    expect(h.logs.filter(line => line.includes("model broker is listening on")).length).toBe(1);
  });

  test("a wildcard gateway is refused before anything binds", async () => {
    const h = await harness();

    for (const gateway of ["0.0.0.0", "::"]) {
      const err = await rejection(h.access.grant({ network: "ompd-net", bridge: hostBridge({ gateway }) }));
      expect(err.message).toContain(JSON.stringify(gateway));
      expect(err.message).toContain("reachable from every container network on this machine");
      expect(err.message).toContain("from the local network");
      expect(err.message).toContain("hand one container's grant to all of them");
    }

    expect(h.audit.map(row => `${row.action}:${row.outcome}`)).toEqual(["model.grant:error", "model.grant:error"]);
    expect(h.issued).toEqual([]);
    expect(await answers(h.brokerUrl)).toBe(false);
  });

  test("the host-alias shape points the guest at the injected hostname, not the bind address", async () => {
    const h = await harness();
    const bridge = hostAlias();

    const granted = await h.access.grant({ network: null, bridge });

    // The single highest-value assertion in this file. `issue` computes its own
    // endpoint from the address it bound, and reading that back would hand a
    // Docker Desktop guest its own loopback, inside the container, where
    // nothing is listening.
    expect(granted.endpoint).toBe(`http://${DESKTOP_ALIAS}:${h.port}`);
    expect(granted.endpoint).not.toContain(LOOPBACK);
    expect(h.issued).toEqual([{ model: MODEL, peerCidr: null }]);

    // Said out loud every time, because it is the one confinement property this
    // daemon knowingly gives up.
    const off = h.logs.filter(line => line.includes("the peer-address check is OFF for this grant"));
    expect(off).toHaveLength(1);
    expect(at(off, 0, "an off-log line")).toContain("host-alias shape NATs every request");
    expect(at(off, 0, "an off-log line")).toContain(LOOPBACK);

    await h.access.activate({ bridge });
    expect(await answers(h.brokerUrl)).toBe(true);
  });

  test("the host-alias shape may not widen past loopback", async () => {
    const h = await harness();

    const err = await rejection(h.access.grant({ network: null, bridge: hostAlias({ bindHost: "192.168.1.5" }) }));

    expect(err.message).toContain("may only bind loopback");
    expect(err.message).toContain(JSON.stringify("192.168.1.5"));
    expect(err.message).toContain("the only");
    expect(h.issued).toEqual([]);
    expect(at(h.audit, 0, "an audit row").detail.bridge).toBe("host-alias");
    expect(await answers(h.brokerUrl)).toBe(false);
  });

  test("a host-alias hostname is held to what a URL, a YAML scalar and a resolver can carry", async () => {
    const h = await harness();

    const refused = [
      // Structurally dangerous: each of these would turn `http://<host>:<port>`
      // into a different address than it reads as, or break the YAML scalar.
      "host.docker.internal/../evil",
      "host.docker.internal:9999",
      "host docker internal",
      "",
      // Merely unresolvable, which the character-set rule this replaced let
      // through. None of them is an origin escape and every one of them is a
      // container that provisions and then cannot reach its own broker, which
      // is the same defect this whole seam exists to remove.
      ".",
      "-",
      "_",
      "a..b",
      "-lead",
      "trail-",
      // A 64-character label, one past the DNS limit.
      `${"a".repeat(64)}.internal`,
      // Valid labels, 313 characters of them.
      `${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.internal`,
    ];

    for (const hostname of refused) {
      const err = await rejection(h.access.grant({ network: null, bridge: hostAlias({ hostname }) }));
      expect(err.message).toContain("is not a hostname a guest can be pointed at");
      expect(err.message).toContain("dot-separated labels");
      expect(err.message).toContain(JSON.stringify(hostname));
    }

    expect(h.issued).toEqual([]);
    expect(h.audit).toHaveLength(refused.length);
  });

  test("the hostname rule still passes the value this path actually uses", async () => {
    const h = await harness();

    // `host.docker.internal` first, because it is the only value the
    // `host-alias` shape ever produces in practice and a rule that refused it
    // would take Docker Desktop off the table entirely. The rest are the forms
    // a tighter rule most easily refuses by accident: one label with no dot, a
    // digit-leading label, and a dash inside a label rather than at its edge.
    for (const hostname of [DESKTOP_ALIAS, "host", "0host.internal", "host-1.docker.internal"]) {
      const granted = await h.access.grant({ network: null, bridge: hostAlias({ hostname }) });
      expect(granted.endpoint).toBe(`http://${hostname}:${h.port}`);
    }

    expect(h.audit.filter(row => row.outcome === "error")).toEqual([]);
  });

  test("the loopback auth services refusing to start is relayed, not swallowed", async () => {
    const h = await harness();
    h.services.ensureFailure = "omp auth-gateway never answered /healthz on 127.0.0.1:51823 (exit 1)";

    const err = await rejection(h.access.grant({ network: "ompd-net", bridge: hostBridge() }));

    expect(err.message).toContain("the loopback omp auth services a container's model access depends on");
    expect(err.message).toContain("would not start");
    expect(err.message).toContain("never answered /healthz on 127.0.0.1:51823");
    expect(at(h.audit, 0, "an audit row").detail.model).toBe(MODEL);
    expect(h.issued).toEqual([]);
  });

  describe("model resolution", () => {
    test("containerModel wins over the host's own default", async () => {
      const h = await harness({ model: "anthropic/claude-opus-5" });
      h.writeHostConfig("modelRoles:\n  default: openai/gpt-5\n");

      const granted = await h.access.grant({ network: "ompd-net", bridge: hostBridge() });

      expect(granted.model).toBe("anthropic/claude-opus-5");
      expect(h.issued).toEqual([{ model: "anthropic/claude-opus-5", peerCidr: LOOPBACK_CIDR }]);
      expect(h.access.status().model).toBe("anthropic/claude-opus-5");
    });

    test("an unset containerModel resolves modelRoles.default from the host config", async () => {
      const h = await harness({ model: "" });
      h.writeHostConfig("modelRoles:\n  default: anthropic/claude-haiku-4-5\n  smol: openai/gpt-5-mini\n");

      const granted = await h.access.grant({ network: "ompd-net", bridge: hostBridge() });

      expect(granted.model).toBe("anthropic/claude-haiku-4-5");
      expect(h.access.status().model).toBe("anthropic/claude-haiku-4-5");
    });

    test("a trailing thinking level is stripped from either source", async () => {
      // The level is omp's own per-role setting and is not part of any model id.
      // The gateway matches the top-level `model` field against its catalog, and
      // every id in that catalog is plain `provider/model`, so a reference
      // carrying `:high` matches nothing and the container fails every prompt.
      const configured = await harness({ model: "anthropic/claude-haiku-4-5:high" });
      expect((await configured.access.grant({ network: "n", bridge: hostBridge() })).model).toBe(MODEL);

      const fromHost = await harness({ model: "" });
      fromHost.writeHostConfig("modelRoles:\n  default: anthropic/claude-opus-5:xhigh\n");
      expect((await fromHost.access.grant({ network: "n", bridge: hostBridge() })).model).toBe(
        "anthropic/claude-opus-5",
      );

      // One trailing segment only, so a provider or model name is never eaten.
      const plain = await harness({ model: "" });
      plain.writeHostConfig("modelRoles:\n  default: openrouter/anthropic/claude-opus-5\n");
      expect((await plain.access.grant({ network: "n", bridge: hostBridge() })).model).toBe(
        "openrouter/anthropic/claude-opus-5",
      );
    });

    const unresolvable: ReadonlyArray<{ name: string; yaml: string | null; says: string }> = [
      { name: "the host config is not there", yaml: null, says: "could not be read from" },
      { name: "the host config is not valid YAML", yaml: "modelRoles: [unclosed", says: "is not valid YAML" },
      { name: "there is no modelRoles block", yaml: "theme: dark\n", says: "is not set to a model id" },
      {
        name: "modelRoles has no default",
        yaml: "modelRoles:\n  smol: openai/gpt-5-mini\n",
        says: "is not set to a model id",
      },
      {
        name: "modelRoles.default is not a string",
        yaml: "modelRoles:\n  default:\n    model: anthropic/claude-opus-5\n    fallbacks: []\n",
        says: "is not set to a model id",
      },
      {
        name: "modelRoles.default is only a thinking level",
        yaml: 'modelRoles:\n  default: ":high"\n',
        says: "is only a thinking level and names no model",
      },
    ];

    for (const scenario of unresolvable) {
      test(`no model is invented when ${scenario.name}`, async () => {
        const h = await harness({ model: "" });
        if (scenario.yaml !== null) h.writeHostConfig(scenario.yaml);

        const err = await rejection(h.access.grant({ network: "ompd-net", bridge: hostBridge() }));

        // Both handles an operator can reach: the daemon config key and the file
        // the host's own choice lives in.
        expect(err.message).toContain("containerModel");
        expect(err.message).toContain(h.hostConfigPath);
        expect(err.message).toContain(scenario.says);
        // Nothing was substituted: no grant, no resolved model, no listener.
        expect(h.issued).toEqual([]);
        expect(h.access.status().model).toBeNull();
        expect(at(h.audit, 0, "an audit row").detail.model).toBeNull();
        expect(at(h.audit, 0, "an audit row").outcome).toBe("error");
        expect(await answers(h.brokerUrl)).toBe(false);
      });
    }
  });

  test("releasing a held token revokes it at the broker while a sibling grant stays live", async () => {
    const h = await harness();
    const bridge = hostBridge();
    const first = await h.access.grant({ network: "ompd-net", bridge });
    const second = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });

    const before = await callBroker(h.brokerUrl, first.token, MODEL);
    expect(before.status).toBe(200);
    // Proof the 200 came from upstream rather than from the broker.
    expect(before.body).toContain(UPSTREAM_MESSAGE_ID);
    const forwarded = at(h.gateway.seen, 0, "a forwarded request");
    expect(forwarded.path).toBe("/v1/messages");
    expect(forwarded.model).toBe(MODEL);
    // The guest's bearer stops at the broker. What goes on is the gateway's,
    // which the guest has never seen.
    expect(forwarded.authorization).toBe(`Bearer ${GATEWAY_BEARER}`);
    expect(forwarded.authorization).not.toContain(first.token);

    await h.access.release({ token: first.token });

    // The listener is still up because a sibling grant is live, which is what
    // makes revocation observable as a 401 rather than as a refused connection.
    const after = await callBroker(h.brokerUrl, first.token, MODEL);
    expect(after.status).toBe(401);
    expect((await callBroker(h.brokerUrl, second.token, MODEL)).status).toBe(200);
    expect(h.broker.liveGrants()).toBe(1);
    // One row, naming the model, and nothing recorded for the sibling grant
    // that is still live.
    expect(h.audit.filter(row => row.action === "model.revoke")).toEqual([
      { action: "model.revoke", outcome: "ok", detail: { model: MODEL } },
    ]);
  });

  test("releasing a token this daemon never held resolves and says so", async () => {
    const h = await harness();
    const bridge = hostBridge();
    const granted = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });

    // A daemon restart drops every broker and every grant with it, so a later
    // release of a token minted by the previous process has nothing to revoke
    // and nothing to leak. This runs on teardown paths that are already
    // unwinding a failure, so a throw here would turn a container that would
    // not start into a container that will not go away.
    await h.access.release({ token: "a-token-from-a-daemon-that-is-no-longer-running" });

    expect(h.audit.filter(row => row.action === "model.revoke")).toEqual([
      { action: "model.revoke", outcome: "ok", detail: { model: null } },
    ]);
    expect(h.logs.some(line => line.includes("does not hold; nothing to revoke"))).toBe(true);
    // It disturbed nothing: the real grant still answers.
    expect((await callBroker(h.brokerUrl, granted.token, MODEL)).status).toBe(200);
    expect(h.broker.liveGrants()).toBe(1);
  });

  test("releasing the last grant drops the bind, and the same address can be granted again", async () => {
    const h = await harness();
    const bridge = hostBridge();
    const first = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });
    expect(await answers(h.brokerUrl)).toBe(true);

    await h.access.release({ token: first.token });

    // When the last container on a network goes, the runtime tears the bridge
    // down and the gateway address stops existing on the host, so a listener
    // kept past the last grant is bound to an address nothing can route to.
    expect(h.logs.some(line => line.includes(`closed the model broker on ${LOOPBACK}:${h.port}`))).toBe(true);
    expect(await answers(h.brokerUrl)).toBe(false);

    // A container landing on a freshly created network with the same gateway
    // address has to be able to bind it, which needs the address dropped from
    // the bound set as well as the broker dropped from the map. This second
    // grant is served by a broker `DaemonModelAccess` builds itself, so it also
    // exercises the live gateway url and bearer wiring the injected spare
    // bypasses.
    const second = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });
    expect(second.token).not.toBe(first.token);
    const reply = await callBroker(h.brokerUrl, second.token, MODEL);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain(UPSTREAM_MESSAGE_ID);
    expect(at(h.gateway.seen, 0, "a forwarded request").authorization).toBe(`Bearer ${GATEWAY_BEARER}`);
    // The old token is dead even though a listener is up on the same address.
    expect((await callBroker(h.brokerUrl, first.token, MODEL)).status).toBe(401);
  });

  test("close revokes everything and leaves the instance able to provision again", async () => {
    const h = await harness();
    const bridge = hostBridge();
    const first = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });
    expect(h.broker.liveGrants()).toBe(1);

    await h.access.close();

    expect(h.broker.liveGrants()).toBe(0);
    expect(h.services.closeCalls).toBe(1);
    expect(await answers(h.brokerUrl)).toBe(false);
    expect(h.logs.some(line => line.includes("closed 1 model broker"))).toBe(true);

    // Not a poison pill: a daemon that closed these on a host release must
    // still be able to provision the next container.
    const second = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });
    expect(second.token).not.toBe(first.token);
    expect((await callBroker(h.brokerUrl, second.token, MODEL)).status).toBe(200);
    expect((await callBroker(h.brokerUrl, first.token, MODEL)).status).toBe(401);
    expect(h.services.ensureCalls).toBeGreaterThanOrEqual(2);
  });

  test("status reads fields only, so ompd doctor can ask before anything is provisioned", async () => {
    const h = await harness({ model: "" });

    // No config.yml exists in this harness, so a status that read one would
    // either throw or invent a model.
    expect(h.access.status()).toEqual({ enabled: true, model: null, gatewayUrl: null, liveGrants: 0 });
    expect(h.services.ensureCalls).toBe(0);
    expect(h.services.bearerCalls).toBe(0);
    expect(h.services.statusCalls).toBe(1);

    const configured = await harness({ model: "anthropic/claude-opus-5:high" });
    expect(configured.access.status()).toEqual({
      enabled: true,
      model: "anthropic/claude-opus-5",
      gatewayUrl: null,
      liveGrants: 0,
    });

    const off = await harness({ enabled: false });
    expect(off.access.status().enabled).toBe(false);
  });

  test("no minted token reaches a log line or an audit row", async () => {
    const h = await harness();
    const bridge = hostBridge();
    const alias = hostAlias();

    const first = await h.access.grant({ network: "ompd-net", bridge });
    await h.access.activate({ bridge });
    expect((await callBroker(h.brokerUrl, first.token, MODEL)).status).toBe(200);
    // A second grant on the same bind address, taking the shape whose log line
    // says the most about the grant.
    const second = await h.access.grant({ network: null, bridge: alias });
    await h.access.activate({ bridge: alias });
    // A refused turn, because a refusal logs the most of any request path.
    expect((await callBroker(h.brokerUrl, first.token, "openai/gpt-5")).status).toBe(403);
    await h.access.release({ token: first.token });
    await h.access.release({ token: second.token });
    await h.access.close();

    const tokens = [first.token, second.token];
    // Guards against a vacuous sweep: with nothing captured, the loop below
    // would pass without looking at anything.
    expect(tokens).toHaveLength(2);
    expect(h.logs.length).toBeGreaterThan(10);
    expect(h.audit.length).toBeGreaterThan(3);
    for (const token of tokens) {
      expect(h.logs.filter(line => line.includes(token))).toEqual([]);
      expect(h.audit.filter(row => JSON.stringify(row.detail).includes(token))).toEqual([]);
    }
    // The upstream credential is not a guest's to see either, and it travels
    // through the same log and audit surfaces.
    expect(h.logs.filter(line => line.includes(GATEWAY_BEARER))).toEqual([]);
    expect(h.audit.filter(row => JSON.stringify(row.detail).includes(GATEWAY_BEARER))).toEqual([]);
  });

  for (const sink of ["audit", "log"] as const) {
    test(`a throwing ${sink} sink unwinds the grant instead of leaving one live that nobody holds`, async () => {
      const h = await harness();
      const reason = `the ${sink} sink is broken`;
      h.breakSink(sink, reason);

      const err = await rejection(h.access.grant({ network: "ompd-net", bridge: hostBridge() }));

      // The mint already happened: `issue` runs before either sink is called.
      // So a rejection on its own is not enough. The token was never returned,
      // which means the provisioner cannot release it, which means a grant left
      // live here is a credential nobody holds and nobody can withdraw, live
      // for its whole 24 hour TTL.
      expect(err.message).toContain("was minted and then withdrawn");
      expect(err.message).toContain(reason);
      expect(h.broker.liveGrants()).toBe(0);
      expect(h.access.status().liveGrants).toBe(0);
      // And nothing spent a single request of the operator's quota through it.
      expect(h.gateway.seen).toEqual([]);
    });
  }

  test("a throwing log sink cannot reach back into the broker's own operations", async () => {
    // No injected spare, so this grant is served by a broker
    // `DaemonModelAccess` constructs itself and whose log sink it wraps. The
    // wrapping is what is under test, and `revoke` is why it exists:
    // `ModelBroker.revoke` deletes the grant and then says it did, so a sink
    // that threw back into it would abandon the unwind `grant` depends on to
    // withdraw a bearer nothing else can reach. `issue` sets its map last, after
    // its own log line, so it is not the case that motivates this -- but a
    // throwing sink still has to leave this daemon able to mint, record, unwind
    // and report, which is the whole sequence this test walks.
    //
    // Done on the first grant rather than by releasing one and granting again,
    // deliberately: a release closes the listener, and a test that gave its port
    // up mid-way would be asserting this property through a window where
    // something else on the machine can take the port.
    const h = await harness({ ownBroker: true });
    h.breakSink("log", "the log sink is broken");

    const err = await rejection(h.access.grant({ network: "ompd-net", bridge: hostBridge() }));

    // The refusal comes from this daemon's own `#log` call, which is not wrapped
    // and has to stay loud, rather than from inside the broker.
    expect(err.message).toContain("was minted and then withdrawn");
    expect(err.message).toContain("the log sink is broken");
    // And the unwind really ran, rather than the grant having been refused
    // somewhere upstream of the mint: this line is the broker's own account of
    // the revocation, written through the wrapped sink. Without the wrapping the
    // throw lands inside `issue` and there is never anything to revoke.
    expect(h.logs.some(line => line.includes(`revoked a grant for ${MODEL}`))).toBe(true);
    expect(h.access.status().liveGrants).toBe(0);
    expect(h.gateway.seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guest's own config
// ---------------------------------------------------------------------------

/**
 * Reusable provider credential shapes.
 *
 * The point of the whole broker is that none of these ever reaches a guest, and
 * `models.yml` is both the file anything in the guest can read and the artifact
 * most likely to be pasted into a log while debugging. So it is worth searching
 * rather than reasoning about.
 */
const CREDENTIAL_SHAPES = /sk-ant-|sk-proj-|sk-or-v1-|github_pat_|ghp_|gho_|AIzaSy|xoxb-|xoxp-/;

const GUEST_TOKEN_PATH = `${GUEST_HOME_MOUNT}/.omp/model-token`;

describe("guest config", () => {
  test("models.yml points at the broker with a command-resolved key and no doubled /v1", () => {
    const endpoint = `http://${LOOPBACK}:7788`;
    const rendered = renderGuestModelsYml({ endpoint, model: MODEL, tokenPath: GUEST_TOKEN_PATH });

    const parsed = mapping(Bun.YAML.parse(rendered), "models.yml");
    const providers = mapping(parsed.providers, "providers");
    expect(Object.keys(providers)).toEqual(["ompd-gateway"]);
    const provider = mapping(providers["ompd-gateway"], "the ompd-gateway provider");

    // The Anthropic SDK appends `/v1/messages` itself, so a baseUrl ending in
    // `/v1` produces `/v1/v1/messages`, which the broker's route allowlist
    // refuses with a 404 that reads like a broken broker.
    expect(provider.baseUrl).toBe(endpoint);
    expect(String(provider.baseUrl)).not.toMatch(/\/v1\/?$/);
    expect(provider.api).toBe("anthropic-messages");
    // A `!`-prefixed value is run and its stdout taken, which keeps the bearer
    // in one 0600 file rather than in this file or in the container's argv.
    expect(provider.apiKey).toBe(`!cat ${GUEST_TOKEN_PATH}`);
    expect(provider.authHeader).toBe(true);
    // The request goes through the broker and then omp's auth-gateway, and a
    // proxy in that position rejects the `strict` field on tool definitions.
    // Left on, the turn fails at the first tool call rather than at connect.
    expect(provider.disableStrictTools).toBe(true);

    const models = list(provider.models, "the provider's models");
    expect(models).toHaveLength(1);
    const only = mapping(at(models, 0, "a model entry"), "the model entry");
    expect(only.id).toBe(MODEL);
    expect(only.name).toBe(MODEL);
    expect(only.contextWindow).toBe(200000);
    expect(only.maxTokens).toBe(8192);
    // Zero because this entry is not a billing surface: real spend is
    // attributed host-side against the credential the gateway resolved, and a
    // made-up per-token price here would be a second, wrong, number for the
    // same request.
    expect(mapping(only.cost, "the model's cost")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("models.yml carries no reusable credential of any shape", () => {
    const rendered = renderGuestModelsYml({
      endpoint: `http://${LOOPBACK}:7788`,
      model: MODEL,
      tokenPath: GUEST_TOKEN_PATH,
    });

    // The canary is proved able to fire before it is trusted to be silent.
    expect("sk-ant-api03-not-a-real-key").toMatch(CREDENTIAL_SHAPES);
    expect(rendered).not.toMatch(CREDENTIAL_SHAPES);
    expect(rendered).not.toContain(GATEWAY_BEARER);
  });

  test("config.yml points default, smol and tiny at the one granted model", () => {
    const parsed = mapping(Bun.YAML.parse(renderGuestConfigYml({ model: MODEL })), "config.yml");
    const roles = mapping(parsed.modelRoles, "modelRoles");

    // `smol` and `tiny` matter as much as `default`: omp uses them for
    // background work it does without being asked, such as session titles and
    // thinking classification, and a role naming a provider the guest does not
    // have makes that work fail silently rather than loudly.
    expect(Object.keys(roles).sort()).toEqual(["default", "smol", "tiny"]);
    expect(roles.default).toBe(`ompd-gateway/${MODEL}`);
    expect(roles.smol).toBe(`ompd-gateway/${MODEL}`);
    expect(roles.tiny).toBe(`ompd-gateway/${MODEL}`);
  });

  test("a value that would escape its YAML scalar is refused, never escaped", () => {
    // Refused rather than escaped, following `requireSafePath`: these values
    // come from daemon config, a container network address and a model id, so
    // one containing a quote is a sign something is wrong upstream and quietly
    // escaping it would hide that.
    for (const hostile of ['"', "'", "\\", "\n", "\r"]) {
      const cases: ReadonlyArray<{ field: string; input: { endpoint: string; model: string; tokenPath: string } }> = [
        {
          field: "endpoint",
          input: { endpoint: `http://${LOOPBACK}:7788${hostile}`, model: MODEL, tokenPath: GUEST_TOKEN_PATH },
        },
        {
          field: "model",
          input: {
            endpoint: `http://${LOOPBACK}:7788`,
            model: `anthropic${hostile}claude`,
            tokenPath: GUEST_TOKEN_PATH,
          },
        },
        {
          field: "tokenPath",
          input: { endpoint: `http://${LOOPBACK}:7788`, model: MODEL, tokenPath: `${GUEST_TOKEN_PATH}${hostile}` },
        },
      ];
      for (const { field, input } of cases) {
        const err = refusal(() => renderGuestModelsYml(input));
        expect(err).toBeInstanceOf(ProvisionError);
        expect(err.message).toContain(`guest model access ${field} contains a quote, backslash or newline`);
        expect((err as ProvisionError).kind).toBe("container");
      }

      const configErr = refusal(() => renderGuestConfigYml({ model: `anthropic${hostile}claude` }));
      expect(configErr).toBeInstanceOf(ProvisionError);
      expect(configErr.message).toContain("guest model access model contains a quote, backslash or newline");
    }
  });

  test("the seeded home holds the bearer, the two config files, and nothing else", () => {
    const access: GuestModelAccess = {
      endpoint: `http://${LOOPBACK}:7788`,
      model: MODEL,
      token: "seeded-bearer-canary-vBqZ9tK3",
    };

    const dir = seedGuestHome({ access });
    seeded.push(dir);

    // An unpredictable directory created 0700 in one step cannot have been
    // pre-created world-writable by another local user, and this one holds a
    // live bearer.
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, ".omp"))).toBe(0o700);
    expect(mode(join(dir, ".omp", "agent"))).toBe(0o700);
    // Exactly this, so an `agent.db`, a copied `~/.omp`, a stray memory store
    // or a second token file would each fail here.
    expect(tree(dir)).toEqual([
      ".omp",
      ".omp/agent",
      ".omp/agent/config.yml",
      ".omp/agent/models.yml",
      ".omp/model-token",
    ]);

    const tokenFile = join(dir, ".omp", "model-token");
    expect(mode(tokenFile)).toBe(0o600);
    // The token and only the token, plus the newline `cat` hands to omp.
    expect(readFileSync(tokenFile, "utf8")).toBe(`${access.token}\n`);

    const modelsPath = join(dir, ".omp", "agent", "models.yml");
    const configPath = join(dir, ".omp", "agent", "config.yml");
    expect(mode(modelsPath)).toBe(0o600);
    expect(mode(configPath)).toBe(0o600);

    const models = readFileSync(modelsPath, "utf8");
    const config = readFileSync(configPath, "utf8");
    // The path baked into models.yml is the path INSIDE the guest. Writing the
    // host path is the most likely mistake in that function and it fails at the
    // first prompt with `cat: no such file`, which reads as a missing token
    // rather than as a wrong path.
    expect(models).toContain(`!cat ${GUEST_HOME_MOUNT}/.omp/model-token`);
    expect(models).not.toContain(dir);
    expect(models).not.toContain(access.token);
    expect(config).not.toContain(access.token);
    expect(models).not.toMatch(CREDENTIAL_SHAPES);

    // A fresh unpredictable directory per container, so two containers never
    // share a home and one's teardown never removes the other's bearer.
    const again = seedGuestHome({ access });
    seeded.push(again);
    expect(again).not.toBe(dir);
  });

  test("a refused render leaves no directory behind holding a token", () => {
    // Guest homes on disk before the refused render, so the delta below is
    // exactly what this call left behind.
    const before = readdirSync(tmpdir()).filter(name => name.startsWith("ompd-guest-"));

    const err = refusal(() =>
      seedGuestHome({
        access: { endpoint: `http://${LOOPBACK}:7788`, model: 'anthropic/"claude', token: "unwritten-bearer" },
      }),
    );

    expect(err).toBeInstanceOf(ProvisionError);
    // Rendered before anything is written, and the directory is removed before
    // the error propagates, so a refused provision leaves nothing on disk.
    const after = readdirSync(tmpdir()).filter(name => name.startsWith("ompd-guest-"));
    expect(after.filter(name => !before.includes(name))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Child output from the loopback omp services
// ---------------------------------------------------------------------------

/**
 * The unauthenticated health paths the real module polls, and the one
 * authenticated read it makes before it calls a gateway usable.
 *
 * Written out here rather than imported, deliberately: a test that read these
 * off the module would keep passing if the module changed them, and the point
 * of the endpoints is that they are a contract with omp rather than with this
 * file.
 */
const BROKER_HEALTH_PATH = "/v1/healthz";
const GATEWAY_HEALTH_PATH = "/healthz";
const CATALOG_PATH = "/v1/models";

/**
 * A loopback server standing in for one of omp's own services.
 *
 * It answers the health flag the readiness poll reads, and the catalog read
 * `#verifyBearerAccepted` makes. A 404 on anything else is not padding: it is
 * how a module that started probing something different shows up as a refused
 * start rather than as a pass.
 */
function fakeOmpService(port: number, healthPath: string): { authorizations: string[]; stop(): Promise<void> } {
  const authorizations: string[] = [];
  const server = Bun.serve({
    hostname: LOOPBACK,
    port,
    fetch: req => {
      const path = new URL(req.url).pathname;
      if (path === healthPath) return Response.json({ ok: true, version: "18.0.4" });
      if (path === CATALOG_PATH) {
        authorizations.push(req.headers.get("authorization") ?? "");
        return Response.json({ data: [{ id: MODEL }] });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  return {
    authorizations,
    stop: async () => {
      await server.stop(true);
    },
  };
}

interface FakeChild {
  process: AuthServiceProcess;
  /** Write one line to the child's stdout, as omp's own logger would. */
  say(line: string): void;
}

/**
 * A child process whose output this file drives one line at a time.
 *
 * `stderr` is null on purpose. The module skips a null stream, so there is
 * exactly one place a forwarded line can have come from and an assertion about
 * it cannot pass on the other stream.
 */
function fakeChild(): FakeChild {
  const encoder = new TextEncoder();
  let out: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start: controller => {
      out = controller;
    },
  });
  const exit = Promise.withResolvers<number>();
  let running = true;
  return {
    process: {
      stdout,
      stderr: null,
      exited: exit.promise,
      kill: () => {
        if (!running) return;
        running = false;
        out?.close();
        // 143, which is what both real services answer to SIGTERM.
        exit.resolve(143);
      },
    },
    say: line => {
      if (out === undefined) throw new Error("the fake child's stdout was never started");
      out.enqueue(encoder.encode(`${line}\n`));
    },
  };
}

interface AuthHarness {
  logs: string[];
  /** What the fake gateway was handed on its catalog read. */
  authorizations: string[];
  /** Write one line as the named child and answer with the line the drain forwarded. */
  say(name: "auth-broker" | "auth-gateway", line: string): Promise<string>;
}

/**
 * The real `OmpAuthServices`, started against fake children.
 *
 * Real because `scrub` is module-private and reaching it any other way would be
 * testing a copy of it. The children are fake and the two loopback servers are
 * real, so `ensure` runs its whole ordering -- broker, health, gateway, health,
 * authenticated catalog read -- and every line a child writes goes through the
 * same drain the daemon uses.
 */
async function authServices(opts: { bearer: string }): Promise<AuthHarness> {
  const configDir = mkdtempSync(join(tmpdir(), "ompd-auth-services-test-"));
  // Where the gateway writes its own inbound bearer, and the only file this
  // module reads.
  writeFileSync(join(configDir, "auth-gateway.token"), `${opts.bearer}\n`, { mode: 0o600 });

  // The broker's port is claimed before the gateway's is asked for, so the
  // kernel cannot hand out the same number twice.
  const brokerPort = await freePort();
  const broker = fakeOmpService(brokerPort, BROKER_HEALTH_PATH);
  const gatewayPort = await freePort();
  const gateway = fakeOmpService(gatewayPort, GATEWAY_HEALTH_PATH);

  const logs: string[] = [];
  const children: Partial<Record<"auth-broker" | "auth-gateway", FakeChild>> = {};
  /** Resolved by the next forwarded line, so `say` awaits the drain rather than a delay. */
  let waiting: ((line: string) => void) | null = null;
  const services = new OmpAuthServices({
    // Never spawned: `spawn` below is injected. A path that cannot exist is
    // deliberate, so an injection that stopped taking fails naming this string
    // instead of quietly starting two real omp children against the operator's
    // own vault.
    ompPath: "/nonexistent/ompctl-test-omp",
    configDir,
    brokerPort,
    gatewayPort,
    readyTimeoutMs: 10_000,
    onLog: line => {
      logs.push(line);
      const resolve = waiting;
      waiting = null;
      resolve?.(line);
    },
    spawn: argv => {
      const name = at(argv, 1, "the service name in a child's argv");
      if (name !== "auth-broker" && name !== "auth-gateway") {
        throw new Error(`the module spawned an unexpected subcommand ${JSON.stringify(name)}`);
      }
      const child = fakeChild();
      children[name] = child;
      return child.process;
    },
  });

  cleanups.push(async () => {
    await services.close();
    await broker.stop();
    await gateway.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  await services.ensure();

  return {
    logs,
    authorizations: gateway.authorizations,
    say: async (name, line) => {
      const child = children[name];
      if (child === undefined) throw new Error(`no fake ${name} child was spawned`);
      const forwarded = Promise.withResolvers<string>();
      waiting = forwarded.resolve;
      child.say(line);
      // Awaiting the drain's own forward rather than a delay: the signal is the
      // thing under test, and a test that slept would pass or flake on timing.
      return await forwarded.promise;
    },
  };
}

/**
 * A gateway bearer that every pattern in `scrub` misses.
 *
 * Dots and slashes, and no unbroken run longer than two characters: it is under
 * the segmented rule's length floor, it carries no `Bearer` prefix, it sits
 * behind no credential-like field name, it is not JWT-shaped, and it has no
 * 32-character run. Nothing but knowing the value can catch it, which is the
 * point: a provider's opaque handle is under no obligation to look like one.
 */
const UNPATTERNED_BEARER = "gw/ab.cd/ef.gh";

describe("omp auth services child output", () => {
  test("a bearer this daemon holds is redacted from a child's line by identity", async () => {
    const h = await authServices({ bearer: UNPATTERNED_BEARER });

    const forwarded = await h.say("auth-gateway", `resolved the operator credential ${UNPATTERNED_BEARER} once`);

    expect(forwarded).toContain("[redacted]");
    expect(forwarded).not.toContain(UNPATTERNED_BEARER);
    // Including the startup lines, one of which is written after the module has
    // used this very value to authenticate its own catalog read.
    expect(h.logs.filter(line => line.includes(UNPATTERNED_BEARER))).toEqual([]);
    expect(h.authorizations).toEqual([`Bearer ${UNPATTERNED_BEARER}`]);
    expect(h.logs.some(line => line.includes("accepted its bearer and offers 1 models"))).toBe(true);
  });

  test("the same value survives when this daemon does not hold it, which is the gap the comment admits", async () => {
    const h = await authServices({ bearer: "some-other-gateway-bearer-entirely" });

    const forwarded = await h.say("auth-gateway", `resolved the operator credential ${UNPATTERNED_BEARER} once`);

    // Not an aspiration and not a defect to fix with another pattern: it is
    // what "best-effort over unpinned child output" means, and it is why the
    // exact-match layer is the half worth relying on. A test that only asserted
    // the redaction would pass just as happily against a pattern that ate the
    // whole line, and would prove nothing about identity.
    expect(forwarded).toContain(UNPATTERNED_BEARER);
  });

  test("a short JWT is redacted, though no run in it is long enough for the other rules", async () => {
    const h = await authServices({ bearer: GATEWAY_BEARER });
    // Three ten-character segments. Under the 32-character floor for an
    // unbroken run and under the 16-character floor the segmented rule wants
    // for one of its runs, so the JWT rule is the only thing that can see it.
    const jwt = "eyJ0eXAiOi.eyJzdWIiOj.SflKxwRJSM";

    const forwarded = await h.say("auth-broker", `the vault answered ${jwt} for the operator`);

    expect(forwarded).not.toContain("eyJ0eXAiOi");
    expect(forwarded).toBe("omp auth-broker: the vault answered [redacted] for the operator");
  });

  test("a dotted opaque token is redacted with no prefix and no field name", async () => {
    const h = await authServices({ bearer: GATEWAY_BEARER });
    // The shape a review named: a Google-style handle whose separators break
    // every run below the 32-character floor, with no `Bearer` in front of it
    // and no `token=` behind it.
    const opaque = "ya29.a0AfB1byC3xQ9mNpLkJ.hGfDsAqWeRtYu";

    const forwarded = await h.say("auth-gateway", `dispatching with ${opaque} to the provider`);

    expect(forwarded).not.toContain("a0AfB1byC3xQ9mNpLkJ");
    expect(forwarded).toBe("omp auth-gateway: dispatching with [redacted] to the provider");
  });

  test("the diagnostic the redaction exists to protect survives it", async () => {
    const h = await authServices({ bearer: GATEWAY_BEARER });
    // The one line on this whole path that says where a child's credential came
    // from. It contains the word `token`, it contains the word `bearer`, and it
    // contains a slashed path of exactly the shape the segmented rule looks at,
    // so all three of the loose rules get a chance at it and none may take it.
    const said = '{"msg":"auth-broker bearer token loaded","path":"/Users/jwaldrip/.omp/auth-broker.token"}';

    const forwarded = await h.say("auth-broker", said);

    expect(forwarded).toBe(`omp auth-broker: ${said}`);
  });
});
