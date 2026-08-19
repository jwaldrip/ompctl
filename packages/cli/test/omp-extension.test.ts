/**
 * `ompd install` writing the omp bridge extension.
 *
 * Three properties, and they are the same three the plist and the binary get,
 * for the same reasons.
 *
 * It must be idempotent, because an operator reruns `ompd install` after every
 * upgrade and two copies of an extension would mean two sockets registering
 * one session.
 *
 * It must refuse a file it did not write. This one is stricter than the plist
 * case: the target is code omp executes in every session it starts, so
 * overwriting someone else's module there is worse than overwriting a launch
 * agent, and the marker is the only thing separating the two cases.
 *
 * Uninstall must remove exactly what install wrote, which means the module and
 * then its directory only when that leaves nothing behind.
 *
 * The last test is the one that keeps the other two honest: the embedded copy
 * the CLI writes has to be the extension source byte for byte, or this suite
 * passes while installing something stale.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CliContext } from "../src/client.ts";
import { BINARY_MARKER } from "../src/install.ts";
import { run } from "../src/main.ts";
import { OMP_BRIDGE_SOURCE } from "../src/omp-bridge-source.ts";
import { agentDir, bridgeExtensionPath, EXTENSION_MARKER } from "../src/omp-extension.ts";

const scratch: string[] = [];

interface Harness {
  ctx: CliContext;
  home: string;
  stdout: () => string;
  stderr: () => string;
}

function harness(env: Record<string, string | undefined> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "ompd-ext-"));
  scratch.push(home);
  writeFileSync(join(home, "token"), "tok_local\n");

  // A binary at the default prefix, inside the temp HOME and therefore outside
  // any checkout, so `install` does not refuse for naming a source path.
  const prefix = join(home, ".local", "bin");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "ompd"), `#!/bin/sh\necho 0.1.0\n${BINARY_MARKER}\n`, { mode: 0o755 });

  const out: string[] = [];
  const err: string[] = [];

  return {
    home,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    ctx: {
      out: line => out.push(line),
      err: line => err.push(line),
      env: { OMPD_URL: "http://127.0.0.1:19999", HOME: home, ...env },
      cwd: home,
      home,
      fetch: async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  };
}

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop() ?? "", { recursive: true, force: true });
});

describe("install", () => {
  test("writes the extension where omp auto-discovers it, and says what changed", async () => {
    const h = harness();

    expect(await run(["install"], h.ctx)).toBe(0);

    const path = bridgeExtensionPath(h.ctx.env);
    expect(path).toBe(join(h.home, ".omp", "agent", "extensions", "ompd-bridge", "index.ts"));
    const written = readFileSync(path, "utf8");
    expect(written).toContain(EXTENSION_MARKER);
    // The loader selects `module.default` and refuses anything else, so this is
    // the difference between an installed extension and a load error in
    // someone's session.
    expect(written).toContain("export default function ompdBridge");
    expect(h.stdout()).toContain(path);
    expect(h.stdout()).toContain("live terminal sessions now appear on paired devices");
    expect(h.stdout()).toContain("already-running omp sessions pick this up when they next start");
  });

  test("honours PI_CODING_AGENT_DIR, because that is the directory omp reads", async () => {
    const h = harness();
    const agent = join(h.home, "elsewhere", "agent");
    h.ctx.env.PI_CODING_AGENT_DIR = agent;

    expect(await run(["install"], h.ctx)).toBe(0);
    expect(agentDir(h.ctx.env)).toBe(agent);
    expect(existsSync(join(agent, "extensions", "ompd-bridge", "index.ts"))).toBe(true);
    expect(existsSync(join(h.home, ".omp", "agent", "extensions", "ompd-bridge", "index.ts"))).toBe(false);
  });

  test("installing twice leaves one copy", async () => {
    const h = harness();

    expect(await run(["install"], h.ctx)).toBe(0);
    const path = bridgeExtensionPath(h.ctx.env);
    const first = readFileSync(path, "utf8");

    expect(await run(["install"], h.ctx)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(readdirSync(dirname(path))).toEqual(["index.ts"]);
    expect(h.stdout()).toContain("reinstalled");
  });

  test("refuses a module ompd did not write, rather than clobbering it", async () => {
    const h = harness();
    const path = bridgeExtensionPath(h.ctx.env);
    mkdirSync(dirname(path), { recursive: true });
    const foreign = "export default function somebodyElsesExtension() {}\n";
    writeFileSync(path, foreign);

    expect(await run(["install"], h.ctx)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(foreign);
    expect(h.stderr()).toContain("ompd did not write it");
    expect(h.stderr()).toContain(EXTENSION_MARKER);
  });
});

describe("uninstall", () => {
  test("removes the module and the directory it created", async () => {
    const h = harness();
    await run(["install"], h.ctx);
    const path = bridgeExtensionPath(h.ctx.env);

    expect(await run(["uninstall"], h.ctx)).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    expect(h.stdout()).toContain(`removed ${path}`);
  });

  test("leaves a directory someone else has put a file in", async () => {
    const h = harness();
    await run(["install"], h.ctx);
    const path = bridgeExtensionPath(h.ctx.env);
    const sibling = join(dirname(path), "notes.md");
    writeFileSync(sibling, "mine\n");

    expect(await run(["uninstall"], h.ctx)).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(sibling, "utf8")).toBe("mine\n");
  });

  test("refuses a foreign module instead of removing it", async () => {
    const h = harness();
    await run(["install"], h.ctx);
    const path = bridgeExtensionPath(h.ctx.env);
    writeFileSync(path, "export default function somebodyElsesExtension() {}\n");

    expect(await run(["uninstall"], h.ctx)).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(h.stderr()).toContain(EXTENSION_MARKER);
  });

  test("removes the extension even when the launch agent is already gone", async () => {
    const h = harness();
    await run(["install"], h.ctx);
    const path = bridgeExtensionPath(h.ctx.env);
    rmSync(join(h.home, "Library", "LaunchAgents", "ai.ompctl.plist"));

    expect(await run(["uninstall"], h.ctx)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe("the embedded extension source", () => {
  test("is the extension source, byte for byte", () => {
    // Regenerated by `bun run gen:omp-bridge`, which `build:cli` runs before it
    // compiles. Without this assertion an edit to the extension ships as a
    // stale copy inside the binary and nothing anywhere says so.
    const source = resolve(import.meta.dir, "..", "..", "omp-extension", "src", "index.ts");
    expect(OMP_BRIDGE_SOURCE).toBe(readFileSync(source, "utf8"));
  });

  test("carries no token, no endpoint, and no absolute path from this machine", () => {
    // The extension reads both at runtime from ~/.ompd. A build that baked
    // either into the installed module would put a credential in a file the
    // CLI writes to every agent directory it touches.
    expect(OMP_BRIDGE_SOURCE).not.toContain("tok_");
    expect(OMP_BRIDGE_SOURCE).toContain('readFileSync(join(home, "token")');
    expect(OMP_BRIDGE_SOURCE).not.toContain(process.env.HOME ?? "/Users");
  });
});
