/**
 * The three frames a phone uses to decide where the next piece of work
 * happens: `fs_list`, `session_create`, and `repo_clone`, over a real socket.
 *
 * They are tested through the wire rather than through the `Filesystem` class
 * -- which has its own suite in `filesystem.test.ts` -- because the properties
 * that matter here belong to the gateway and not to the filesystem: the manage
 * gate, the audit record written at every exit, the answer being the existing
 * `session_opened` frame so a client needs no new case, and the clone dying
 * with the socket that asked for it.
 *
 * `session_create` runs against the fake ACP host, so a session is really
 * created through `Supervisor.createAgent` -- the same call `POST /v1/agents`
 * makes -- without spawning `omp`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditEntry,
  type ClientFrame,
  DefaultPolicy,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
} from "@ompd/core";
import { Filesystem } from "../src/filesystem/index.ts";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratch: string[] = [];

/**
 * Deadline for a frame that should already be on its way. It never elapses on
 * a passing run; it exists so a missing frame fails naming what was expected
 * instead of hanging.
 */
const SIGNAL_DEADLINE_MS = 5000;

function tempDir(prefix: string): string {
  // Realpath'd, because the daemon answers with resolved paths and on macOS
  // `/var` is a symlink: an unresolved expectation would compare a path the
  // kernel never uses.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

async function connect(port: number, token: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
  const opened = Promise.withResolvers<boolean>();
  const frames: ServerFrame[] = [];
  let cursor = 0;
  let pending: { check: () => boolean; settle: (frame: ServerFrame | null) => void; timer: Timer } | null = null;

  const drain = (): void => {
    if (!pending) return;
    if (!pending.check()) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.settle(frames[cursor - 1] ?? null);
  };

  ws.addEventListener("open", () => opened.resolve(true));
  ws.addEventListener("error", () => opened.resolve(false));
  ws.addEventListener("close", () => opened.resolve(false));
  ws.addEventListener("message", event => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
    drain();
  });

  if (!(await opened.promise)) throw new Error("expected the websocket to open");

  return {
    frames,
    send: frame => ws.send(JSON.stringify(frame)),
    next: (match, label) => {
      const settled = Promise.withResolvers<ServerFrame>();
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = {
        // The cursor steps past frames that do not match, so a later `next`
        // never re-matches one an earlier call already stepped over.
        check: () => {
          while (cursor < frames.length) {
            const frame = frames[cursor];
            cursor += 1;
            if (frame && match(frame)) return true;
          }
          return false;
        },
        settle: frame => {
          if (frame) settled.resolve(frame);
        },
        timer,
      };
      drain();
      return settled.promise;
    },
    close: () => ws.close(),
  };
}

interface Harness {
  port: number;
  store: Store;
  fake: FakeHostController;
  /** The one configured root, realpath'd. */
  root: string;
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
  auditOf(action: AuditEntry["action"]): AuditEntry[];
}

/**
 * A gateway with one temp root, a fake ACP host, and a paired-device factory.
 * `roots` overrides the configured set; `spawn` substitutes the clone's child,
 * which is how the socket-close test drives a clone that outlives its frame.
 */
async function harness(
  roots?: string[],
  spawn?: ConstructorParameters<typeof Filesystem>[0]["spawn"],
): Promise<Harness> {
  const store = new Store(join(tempDir("rs-db-"), "ompd.db"));
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const root = roots === undefined ? tempDir("rs-root-") : (roots[0] ?? tempDir("rs-root-"));
  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    filesystem: new Filesystem({
      roots: roots ?? [root],
      ...(spawn === undefined ? {} : { spawn }),
    }),
  });
  gateways.push(gw);
  const port = await gw.listen();

  return {
    port,
    store,
    fake,
    root,
    pair: async scopes => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    connect: token => connect(port, token),
    auditOf: action => store.listAudit(200).filter(entry => entry.action === action),
  };
}

function isListing(frame: ServerFrame): frame is Extract<ServerFrame, { t: "fs_listing" }> {
  return frame.t === "fs_listing";
}

function isError(frame: ServerFrame): frame is Extract<ServerFrame, { t: "error" }> {
  return frame.t === "error";
}

afterEach(async () => {
  for (const gw of gateways.splice(0)) await gw.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fs_list
// ---------------------------------------------------------------------------

describe("the fs_list frame", () => {
  test("lists a root, marking the git working trees in it", async () => {
    const h = await harness();
    mkdirSync(join(h.root, "ompctl", ".git"), { recursive: true });
    mkdirSync(join(h.root, "scratch"));
    writeFileSync(join(h.root, "notes.md"), "hello\n");
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "fs_list", path: h.root });
    const frame = await phone.next(isListing, "the listing");
    if (!isListing(frame)) throw new Error("unreachable");

    expect(frame.path).toBe(h.root);
    expect(frame.parent).toBeNull();
    expect(frame.roots).toEqual([h.root]);
    expect(frame.bounded).toBe(false);
    expect(frame.entries).toEqual([
      { name: "ompctl", kind: "dir", gitRepo: true },
      { name: "scratch", kind: "dir" },
      { name: "notes.md", kind: "file" },
    ]);
  });

  test("answers the configured roots when the frame carries no path", async () => {
    const first = tempDir("rs-root-a-");
    const second = tempDir("rs-root-b-");
    const h = await harness([first, second]);
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "fs_list" });
    const frame = await phone.next(isListing, "the roots listing");
    if (!isListing(frame)) throw new Error("unreachable");

    expect(frame.path).toBe("");
    expect(frame.roots).toEqual([first, second]);
    expect(frame.entries.map(entry => entry.name)).toEqual([first, second]);
  });

  test("bounds a huge directory and says so on the wire", async () => {
    const h = await harness();
    const crowded = join(h.root, "crowded");
    mkdirSync(crowded);
    for (let index = 0; index < 620; index += 1) {
      writeFileSync(join(crowded, `entry-${String(index).padStart(5, "0")}.txt`), "x");
    }
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "fs_list", path: crowded });
    const frame = await phone.next(isListing, "the bounded listing");
    if (!isListing(frame)) throw new Error("unreachable");

    expect(frame.bounded).toBe(true);
    expect(frame.entries).toHaveLength(500);
    expect(h.auditOf("fs.list").at(0)?.detail).toMatchObject({ path: crowded, bounded: true });
  });

  test("refuses a path outside the roots without listing it, and audits the refusal", async () => {
    const h = await harness();
    const outside = tempDir("rs-outside-");
    mkdirSync(join(outside, "private"));
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "fs_list", path: outside });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("out_of_roots");
    expect(phone.frames.some(isListing)).toBe(false);
    expect(h.auditOf("fs.list").at(0)).toMatchObject({ outcome: "denied", detail: { reason: "out_of_roots" } });
  });

  test("refuses a symlink inside the roots that points out of them", async () => {
    const h = await harness();
    const outside = tempDir("rs-outside-");
    mkdirSync(join(outside, "secrets"));
    symlinkSync(join(outside, "secrets"), join(h.root, "escape"));
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "fs_list", path: join(h.root, "escape") });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("out_of_roots");
    expect(phone.frames.some(isListing)).toBe(false);
  });

  test("refuses a device that holds read but not manage", async () => {
    const h = await harness();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "fs_list", path: h.root });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("unauthorized");
    expect(phone.frames.some(isListing)).toBe(false);
    expect(h.auditOf("fs.list").at(0)).toMatchObject({ outcome: "denied", detail: { reason: "unauthorized" } });
  });
});

// ---------------------------------------------------------------------------
// session_create
// ---------------------------------------------------------------------------

describe("the session_create frame", () => {
  test("creates exactly one agent at the chosen directory and answers session_opened", async () => {
    const h = await harness();
    const work = join(h.root, "alpha");
    mkdirSync(work);
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "session_create", cwd: work });
    const frame = await phone.next(candidate => candidate.t === "session_opened", "session_opened");
    if (frame.t !== "session_opened") throw new Error("unreachable");

    const agents = h.store.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.cwd).toBe(work);
    expect(agents[0]?.id).toBe(frame.agentId);
    // The session id is the ACP session the supervisor opened, so the answer a
    // client acts on names the same session the daemon holds.
    expect(frame.sessionId).toBe(agents[0]?.acpSessionId ?? "");
    // Through the same supervisor path `POST /v1/agents` takes, which is what
    // `session/new` carrying the chosen cwd proves.
    expect(h.fake.newRequests).toEqual([{ cwd: work, mcpServers: [] }]);
    // The directory's own name, because that is what an operator would type.
    expect(agents[0]?.name).toBe("alpha");
    expect(h.auditOf("session.create").at(0)).toMatchObject({ outcome: "ok", detail: { cwd: work, name: "alpha" } });
  });

  test("takes the name it was given over the directory's", async () => {
    const h = await harness();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "session_create", cwd: h.root, name: "deploy checks" });
    await phone.next(candidate => candidate.t === "session_opened", "session_opened");

    expect(h.store.listAgents().at(0)?.name).toBe("deploy checks");
  });

  test("refuses a cwd that is not a directory, and creates nothing", async () => {
    const h = await harness();
    const file = join(h.root, "notes.md");
    writeFileSync(file, "hello\n");
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "session_create", cwd: file });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("not_a_directory");
    expect(h.store.listAgents()).toEqual([]);
    expect(h.fake.newRequests).toEqual([]);
  });

  test("refuses a cwd outside the roots, and creates nothing", async () => {
    const h = await harness();
    const outside = tempDir("rs-outside-");
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "session_create", cwd: outside });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("out_of_roots");
    expect(h.store.listAgents()).toEqual([]);
    expect(h.fake.newRequests).toEqual([]);
    expect(h.auditOf("session.create").at(0)).toMatchObject({ outcome: "denied", detail: { reason: "out_of_roots" } });
  });

  test("refuses a device without manage, and creates nothing", async () => {
    const h = await harness();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "session_create", cwd: h.root });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("unauthorized");
    expect(h.store.listAgents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// repo_clone
// ---------------------------------------------------------------------------

/** A git repository with one commit, so a clone needs no network. */
async function fixtureRepo(): Promise<string> {
  const dir = tempDir("rs-fixture-repo-");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  const git = async (...args: string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=fixture@ompd.test", "-c", "user.name=Fixture", "add", "README.md");
  await git("-c", "user.email=fixture@ompd.test", "-c", "user.name=Fixture", "commit", "-q", "-m", "first");
  return dir;
}

describe("the repo_clone frame", () => {
  test("clones a local fixture, streams progress, and answers clone_done", async () => {
    const h = await harness();
    const source = await fixtureRepo();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "repo_clone", url: source, parent: h.root, name: "cloned" });
    const progress = await phone.next(frame => frame.t === "clone_progress", "a progress frame");
    const done = await phone.next(frame => frame.t === "clone_done", "clone_done");
    if (progress.t !== "clone_progress" || done.t !== "clone_done") throw new Error("unreachable");

    expect(progress.line.length).toBeGreaterThan(0);
    expect(progress.cloneId).toBe(done.cloneId);
    expect(done.path).toBe(join(h.root, "cloned"));
    expect(await Bun.file(join(done.path, "README.md")).text()).toBe("fixture\n");
  });

  test("audits the clone with its url and destination, and no credential", async () => {
    const h = await harness();
    const source = await fixtureRepo();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "repo_clone", url: source, parent: h.root, name: "cloned" });
    await phone.next(frame => frame.t === "clone_done", "clone_done");

    const entry = h.auditOf("repo.clone").at(0);
    expect(entry).toMatchObject({ outcome: "ok", detail: { url: source, path: join(h.root, "cloned") } });
    // Every audit record for this action, checked as text: no clone whose url
    // could have carried a credential ever reaches this table, because the
    // credential-bearing forms are refused before the record is written.
    const written = JSON.stringify(h.auditOf("repo.clone"));
    expect(written).not.toContain("@");
    expect(written).not.toContain("ghp_");
  });

  test("refuses a url carrying a credential, creates nothing, and never logs the url", async () => {
    const h = await harness();
    const token = "ghp_deadbeefdeadbeefdeadbeef";
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({
      t: "repo_clone",
      url: `https://x-access-token:${token}@github.com/jwaldrip/ompctl.git`,
      parent: h.root,
      name: "private",
    });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("credential_in_url");
    expect(frame.message).not.toContain(token);
    expect(existsSync(join(h.root, "private"))).toBe(false);
    const entry = h.auditOf("repo.clone").at(0);
    expect(entry).toMatchObject({ outcome: "denied", detail: { reason: "credential_in_url" } });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  test("refuses a destination that already exists, and leaves it alone", async () => {
    const h = await harness();
    const source = await fixtureRepo();
    mkdirSync(join(h.root, "taken"));
    writeFileSync(join(h.root, "taken", "keep.txt"), "mine\n");
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "repo_clone", url: source, parent: h.root, name: "taken" });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("target_exists");
    expect(await Bun.file(join(h.root, "taken", "keep.txt")).text()).toBe("mine\n");
  });

  test("refuses a traversal in the name and a parent outside the roots, creating nothing", async () => {
    const h = await harness();
    const source = await fixtureRepo();
    const outside = tempDir("rs-outside-");
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "repo_clone", url: source, parent: h.root, name: "../escaped" });
    const traversal = await phone.next(isError, "the traversal refusal");
    phone.send({ t: "repo_clone", url: source, parent: outside, name: "elsewhere" });
    const outOfRoots = await phone.next(isError, "the out-of-roots refusal");
    if (!isError(traversal) || !isError(outOfRoots)) throw new Error("unreachable");

    expect(traversal.code).toBe("bad_name");
    expect(outOfRoots.code).toBe("out_of_roots");
    expect(existsSync(join(h.root, "..", "escaped"))).toBe(false);
    expect(existsSync(join(outside, "elsewhere"))).toBe(false);
  });

  test("refuses a device without manage, and creates nothing", async () => {
    const h = await harness();
    const source = await fixtureRepo();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "repo_clone", url: source, parent: h.root, name: "nope" });
    const frame = await phone.next(isError, "the refusal");
    if (!isError(frame)) throw new Error("unreachable");

    expect(frame.code).toBe("unauthorized");
    expect(existsSync(join(h.root, "nope"))).toBe(false);
  });

  test("kills the child when the socket that asked for the clone goes away", async () => {
    // A child that reports itself started and then holds itself open, standing
    // in for a clone still running when the operator walks out of range. The
    // test waits on that report rather than on a duration.
    const pidFile = join(tempDir("rs-clone-pid-"), "pid");
    const h = await harness(undefined, () =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); console.error("started"); setInterval(() => {}, 1000);`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_MANAGE]));

    phone.send({ t: "repo_clone", url: "https://example.com/repo.git", parent: h.root, name: "slow" });
    await phone.next(frame => frame.t === "clone_progress", "the first progress frame");
    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(Number.isSafeInteger(pid)).toBe(true);
    // Alive right now: signal 0 tests for existence without touching it.
    expect(() => process.kill(pid, 0)).not.toThrow();

    phone.close();

    // Polls the process table for the child's disappearance rather than
    // sleeping a guessed interval: the assertion is "it went away", and this
    // returns the moment that becomes true.
    const gone = await waitForExit(pid);
    expect(gone).toBe(true);
  });
});

/** Resolve once `pid` is no longer a live process, or reject at the deadline. */
async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + SIGNAL_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  throw new Error(`process ${pid} was still alive at the deadline`);
}

process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
