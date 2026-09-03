/**
 * `ompd mcp install`, tested as the thing it actually is: a rewrite of a file
 * somebody else owns.
 *
 * The interesting failures are all destructive rather than incorrect. omp's
 * `mcp.json` is hand-edited, it holds other people's servers, and one of those
 * URLs on this author's machine carries a credential. An install that dropped
 * a key, or that started fresh because it could not parse what was there,
 * would be discovered later, by somebody wondering where their server went.
 *
 * So the no-clobber case is asserted against the real shape of a real config,
 * byte for byte, rather than a fixture invented to pass: `$schema`, a
 * `mcpServers` entry that is not ours, and a `disabledServers` list with two
 * names in it that have nothing to do with ompd.
 *
 * Two more properties get their own tests. Installing twice must leave the
 * file byte-identical, because "did this change anything" has to be answerable
 * by looking at the file. And `disabledServers` naming us must be cleared,
 * loudly: that list overrides every registration, so leaving it produces an
 * install that reads as done and does nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../src/client.ts";
import { run } from "../src/main.ts";
import type { OmpMcpInstallPlan } from "../src/mcp/omp-config.ts";
import { applyOmpMcpInstall, OMP_MCP_SERVER_NAME, ompMcpConfigPath, planOmpMcpInstall } from "../src/mcp/omp-config.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ompd-mcp-"));
  scratch.push(dir);
  return dir;
}

/**
 * omp's config as it is on this machine, with the credential removed.
 *
 * Kept as the exact three-key shape rather than a minimal one: the whole point
 * of these tests is that a real file survives, and a fixture that omits
 * `$schema` or `disabledServers` cannot prove that.
 */
const REAL_CONFIG = `{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "postiz": {
      "type": "http",
      "url": "https://mcp.postiz.com/mcp/redacted"
    }
  },
  "disabledServers": [
    "jira:atlassian",
    "cld:postiz"
  ]
}
`;

/** Plan and write in one step, the way the command does. */
function install(path: string, command: string): OmpMcpInstallPlan {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const plan = planOmpMcpInstall({ existing, path, command });
  applyOmpMcpInstall(plan);
  return plan;
}

/** The parsed config, as an indexable object, or a failure if it is not one. */
function readConfig(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} did not parse as a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

describe("registering ompd with omp", () => {
  test("a fresh install writes a stdio entry naming the absolute binary", () => {
    const dir = scratchDir();
    const path = join(dir, ".omp", "agent", "mcp.json");
    const binary = join(dir, ".local", "bin", "ompd");

    const plan = install(path, binary);

    expect(plan.changed).toBe(true);
    // Parsed, not string-matched: the file has to be loadable by omp, and a
    // trailing-comma or double-encoded document would still contain the path.
    const config = readConfig(path);
    expect(config.mcpServers).toEqual({ [OMP_MCP_SERVER_NAME]: { type: "stdio", command: binary, args: ["mcp"] } });
    expect(config.$schema).toContain("mcp-schema.json");
  });

  test("installing over a real config keeps every key that is not ours", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, REAL_CONFIG);

    install(path, "/opt/bin/ompd");

    const config = readConfig(path);
    // The schema URL is a statement about which omp wrote the file. ompd does
    // not get to answer that question on an existing config.
    expect(config.$schema).toBe(
      "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    );
    expect(config.mcpServers).toEqual({
      postiz: { type: "http", url: "https://mcp.postiz.com/mcp/redacted" },
      [OMP_MCP_SERVER_NAME]: { type: "stdio", command: "/opt/bin/ompd", args: ["mcp"] },
    });
    // Both unrelated denylist entries, in order. A filter that rebuilt this
    // list from what ompd cares about would drop them.
    expect(config.disabledServers).toEqual(["jira:atlassian", "cld:postiz"]);
  });

  test("a second install changes nothing and rewrites nothing", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, REAL_CONFIG);

    install(path, "/opt/bin/ompd");
    const afterFirst = readFileSync(path, "utf8");

    const second = install(path, "/opt/bin/ompd");

    expect(second.changed).toBe(false);
    expect(second.notes.join("\n")).toContain("nothing to change");
    // Bytes, not a parsed comparison. A no-op that reformatted the file would
    // still pass a deep-equal and would still churn the operator's config.
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });

  test("a binary that moved re-points only our entry, and says where it was", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, REAL_CONFIG);
    install(path, "/old/bin/ompd");

    const plan = install(path, "/new/bin/ompd");

    expect(plan.changed).toBe(true);
    expect(plan.notes.join("\n")).toContain("/old/bin/ompd");
    expect(plan.notes.join("\n")).toContain("/new/bin/ompd");
    const config = readConfig(path);
    expect(config.mcpServers).toEqual({
      postiz: { type: "http", url: "https://mcp.postiz.com/mcp/redacted" },
      [OMP_MCP_SERVER_NAME]: { type: "stdio", command: "/new/bin/ompd", args: ["mcp"] },
    });
  });

  test("a denylisted ompctl is re-enabled, and the note says so", () => {
    // The failure this prevents: `disabledServers` wins over every
    // registration, so an install that left it would report success and
    // produce a server omp never spawns.
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, `${JSON.stringify({ disabledServers: [OMP_MCP_SERVER_NAME, "cld:postiz"] }, null, 2)}\n`);

    const plan = install(path, "/opt/bin/ompd");

    expect(plan.changed).toBe(true);
    expect(plan.notes.join("\n")).toContain("disabledServers");
    expect(readConfig(path).disabledServers).toEqual(["cld:postiz"]);
  });

  test("an unreadable config is refused, not replaced", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    const broken = '{ "mcpServers": { "postiz": { "type": "http" } },\n';
    writeFileSync(path, broken);

    expect(() => install(path, "/opt/bin/ompd")).toThrow(/refusing to rewrite/);
    // The bytes are the assertion. "It threw" is not the property that
    // matters; "the operator still has their config" is.
    expect(readFileSync(path, "utf8")).toBe(broken);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test("an mcpServers that is not an object is refused too", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, '{ "mcpServers": [] }\n');

    expect(() => install(path, "/opt/bin/ompd")).toThrow(/mcpServers is not an object/);
  });

  test("modifying an existing config leaves a .bak holding the previous bytes", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, REAL_CONFIG);

    install(path, "/opt/bin/ompd");

    expect(readFileSync(`${path}.bak`, "utf8")).toBe(REAL_CONFIG);
  });

  test("the .bak carries the config's own mode, never a mode already sitting at that name", () => {
    const dir = scratchDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, REAL_CONFIG);
    chmodSync(path, 0o600);
    // A file already at the backup name, left loose. `copyFileSync` opens an
    // existing destination O_TRUNC on Linux and ignores its mode argument, so
    // the copy would keep these bits and hold a config that carries
    // credentials in its server URLs.
    writeFileSync(`${path}.bak`, "stale");
    chmodSync(`${path}.bak`, 0o666);

    install(path, "/opt/bin/ompd");

    expect(readFileSync(`${path}.bak`, "utf8")).toBe(REAL_CONFIG);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
  });

  test("a config that cannot be read is refused rather than overwritten with no backup", () => {
    const dir = scratchDir();
    // A directory at the config path: statSync succeeds, so this is not the
    // errno under test. Point at a path whose PARENT is unreadable instead,
    // which is the shape that yields EACCES on the stat and used to read as
    // "no file yet", skipping the backup and renaming over whatever was there.
    const locked = join(dir, "locked");
    mkdirSync(locked, { recursive: true });
    const path = join(locked, "mcp.json");
    writeFileSync(path, REAL_CONFIG);
    chmodSync(locked, 0o000);

    try {
      expect(() => install(path, "/opt/bin/ompd")).toThrow(/refusing to overwrite a config this command cannot copy/);
    } finally {
      // Restore before the scratch teardown, or rmSync cannot descend.
      chmodSync(locked, 0o700);
    }

    expect(readFileSync(path, "utf8")).toBe(REAL_CONFIG);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test("a fresh config is created 0600, and a tightened one keeps its mode", () => {
    const dir = scratchDir();
    const fresh = join(dir, "fresh", "mcp.json");
    install(fresh, "/opt/bin/ompd");
    // An mcp.json holds server URLs with credentials in them, as omp's own
    // does today, so a new one is not world readable.
    expect(statSync(fresh).mode & 0o777).toBe(0o600);

    const loose = join(dir, "mcp.json");
    writeFileSync(loose, REAL_CONFIG);
    // Set after the write: the `mode` option on create is masked by umask, so
    // asserting on it would make this test depend on the shell that ran it.
    chmodSync(loose, 0o644);
    install(loose, "/opt/bin/ompd");
    expect(statSync(loose).mode & 0o777).toBe(0o644);
  });
});

describe("finding omp's config", () => {
  test("the default is ~/.omp/agent/mcp.json", () => {
    expect(ompMcpConfigPath({}, "/home/j")).toBe("/home/j/.omp/agent/mcp.json");
  });

  test("OMP_PROFILE moves it under profiles/", () => {
    expect(ompMcpConfigPath({ OMP_PROFILE: "glimmer" }, "/home/j")).toBe(
      "/home/j/.omp/profiles/glimmer/agent/mcp.json",
    );
    // Empty is not a profile. An exported-but-blank variable must not send
    // this to `profiles//agent`.
    expect(ompMcpConfigPath({ OMP_PROFILE: "" }, "/home/j")).toBe("/home/j/.omp/agent/mcp.json");
  });

  test("PI_CODING_AGENT_DIR outranks both, because omp reads its config from there", () => {
    expect(ompMcpConfigPath({ PI_CODING_AGENT_DIR: "/srv/agent", OMP_PROFILE: "glimmer" }, "/home/j")).toBe(
      "/srv/agent/mcp.json",
    );
  });
});

describe("the mcp verbs", () => {
  /**
   * Enough context to run a command that never reaches the daemon. `HOME` is
   * the temp tree, so both the binary `resolveProgram` finds and the config
   * this writes land inside it.
   */
  function context(home: string): { ctx: CliContext; stdout: () => string; stderr: () => string } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      ctx: {
        out: line => out.push(line),
        err: line => err.push(line),
        env: { HOME: home },
        cwd: home,
        home,
        fetch: () => Promise.reject(new Error("mcp install must not touch the daemon")),
        exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      },
      stdout: () => out.join("\n"),
      stderr: () => err.join("\n"),
    };
  }

  test("install registers the installed binary by absolute path", async () => {
    const home = scratchDir();
    const prefix = join(home, ".local", "bin");
    mkdirSync(prefix, { recursive: true });
    const binary = join(prefix, "ompd");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    const h = context(home);

    expect(await run(["mcp", "install"], h.ctx)).toBe(0);

    const path = join(home, ".omp", "agent", "mcp.json");
    expect(h.stdout()).toContain(path);
    expect(h.stdout()).toContain(`${binary} mcp`);
    expect(readConfig(path).mcpServers).toEqual({
      [OMP_MCP_SERVER_NAME]: { type: "stdio", command: binary, args: ["mcp"] },
    });
  });

  test("install refuses a source checkout rather than writing a path omp cannot exec", async () => {
    // No binary under the temp `HOME`, so the only candidate left is this
    // source tree, which omp would have to run through an interpreter it does
    // not inherit, at a path that disappears with the worktree.
    const home = scratchDir();
    const h = context(home);

    expect(await run(["mcp", "install"], h.ctx)).toBe(1);
    expect(h.stderr()).toContain("refusing to register");
    expect(h.stderr()).toContain("ompd self-install");
    expect(existsSync(join(home, ".omp", "agent", "mcp.json"))).toBe(false);
  });
});
