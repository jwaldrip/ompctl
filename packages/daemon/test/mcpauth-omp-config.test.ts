/**
 * Writing into `~/.omp/agent/mcp.json` is a whole-file replace, so every test
 * here is about something that must survive a write ompd did not think about.
 *
 * The two properties the file's design rests on are asserted separately,
 * because they fail separately. Read-merge-write is what keeps the operator's
 * other servers; a freshness token compared at write time is what keeps an
 * `/mcp add` that landed while ompd was thinking. Merging without the token
 * silently reverts a human's edit, and the token without merging silently
 * deletes everything else, so neither one alone is the guard.
 *
 * Nothing here reads `~/.omp` or `~/.ompd`. Every path is inside a temp
 * directory created per test, which is also what makes the "no token value in
 * the file" assertion meaningful: the loopback token is a real secret written to
 * a real file, and the check is on the config file's actual bytes rather than on
 * what a redaction helper claims about them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBrokeredServers,
  type BrokeredServerEntry,
  MCP_AUTH_HEADER,
  ompMcpConfigPath,
  readOmpMcpConfig,
  readOwnership,
  removeBrokeredServers,
} from "../src/mcpauth/omp-config.ts";

const SCHEMA =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/**
 * A config file with the shapes a real one has: a schema line, a stdio server,
 * a remote server, an operator's own disable, and a key ompd has never heard of.
 * Every one of them is something a partial write would destroy.
 */
const POPULATED = `${JSON.stringify(
  {
    $schema: SCHEMA,
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      "vendor:notes": { type: "http", url: "https://mcp.notes.test/mcp" },
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    },
    disabledServers: ["something-the-operator-turned-off"],
    enabledServers: ["tool-owned-server"],
  },
  null,
  2,
)}\n`;

interface Fixture {
  configPath: string;
  ownershipPath: string;
  tokenPath: string;
  /** The loopback caller-auth token's actual value. It must never reach the config file. */
  tokenValue: string;
}

const dirs: string[] = [];

function fixture(initial?: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ompd-mcpauth-config-"));
  dirs.push(dir);
  const agent = join(dir, "omp", "agent");
  const home = join(dir, "ompd");
  mkdirSync(agent, { recursive: true });
  mkdirSync(home, { recursive: true });
  const configPath = join(agent, "mcp.json");
  if (initial !== undefined) writeFileSync(configPath, initial);
  const tokenValue = `loopback-secret-${crypto.randomUUID()}`;
  const tokenPath = join(home, "mcp-auth.token");
  writeFileSync(tokenPath, `${tokenValue}\n`, { mode: 0o600 });
  return { configPath, ownershipPath: join(home, "mcp-auth-config.json"), tokenPath, tokenValue };
}

function entry(f: Fixture, over: Partial<BrokeredServerEntry> = {}): BrokeredServerEntry {
  return {
    brokerName: "notes-ompd",
    originalName: "vendor:notes",
    grantId: "mcpauth_0123456789abcdef",
    port: 8722,
    tokenPath: f.tokenPath,
    ...over,
  };
}

/** Apply against a token read immediately beforehand, which is the happy path. */
function applyFresh(f: Fixture, entries: BrokeredServerEntry[]) {
  const { token } = readOmpMcpConfig(f.configPath);
  return applyBrokeredServers(f.configPath, entries, token, { ownershipPath: f.ownershipPath });
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("reading the file, and the token that says which bytes were read", () => {
  test("an absent file reads as empty with an unambiguous token", () => {
    const f = fixture();
    expect(readOmpMcpConfig(f.configPath)).toEqual({ doc: {}, token: "v1:absent" });
  });

  test("the token tracks the raw bytes, not the reserialised document", () => {
    const f = fixture(POPULATED);
    const first = readOmpMcpConfig(f.configPath).token;
    // Reindenting changes nothing a JSON parser would report and everything
    // about whether this is the file that was merged against.
    writeFileSync(f.configPath, `${JSON.stringify(JSON.parse(POPULATED), null, 4)}\n`);
    expect(readOmpMcpConfig(f.configPath).token).not.toBe(first);
  });

  test("a file that is present but unparseable throws instead of reading as empty", () => {
    const f = fixture('{"mcpServers": {,,,}');
    expect(() => readOmpMcpConfig(f.configPath)).toThrow(/not valid JSON/);
  });
});

describe("a partial edit preserves everything else", () => {
  test("every other server and every other top-level key survives an apply", () => {
    const f = fixture(POPULATED);
    const result = applyFresh(f, [entry(f)]);
    expect(result.written).toBe(true);

    const after = readOmpMcpConfig(f.configPath).doc;
    expect(Object.keys(after.mcpServers ?? {})).toEqual(["filesystem", "vendor:notes", "github", "notes-ompd"]);
    expect(after.mcpServers?.filesystem).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    expect(after.mcpServers?.["vendor:notes"]).toEqual({ type: "http", url: "https://mcp.notes.test/mcp" });
    expect(after.mcpServers?.github).toEqual({ type: "http", url: "https://api.githubcopilot.com/mcp/" });
    expect(after.$schema).toBe(SCHEMA);
    expect(after.enabledServers).toEqual(["tool-owned-server"]);
    // `$schema` first is the shape an editor and a human both expect.
    expect(Object.keys(after)).toEqual(["$schema", "mcpServers", "disabledServers", "enabledServers"]);
  });

  test("a second apply updates the brokered entry in place rather than appending a duplicate", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f)]);
    applyFresh(f, [entry(f, { port: 8899 })]);

    const after = readOmpMcpConfig(f.configPath).doc;
    expect(Object.keys(after.mcpServers ?? {})).toEqual(["filesystem", "vendor:notes", "github", "notes-ompd"]);
    expect(after.mcpServers?.["notes-ompd"]).toMatchObject({
      url: "http://127.0.0.1:8899/mcp/mcpauth_0123456789abcdef",
    });
    expect(after.disabledServers).toEqual(["something-the-operator-turned-off", "vendor:notes"]);
  });

  test("a first apply onto a machine with no config file at all still writes a usable file", () => {
    const f = fixture();
    const result = applyBrokeredServers(f.configPath, [entry(f)], "v1:absent", { ownershipPath: f.ownershipPath });
    expect(result.written).toBe(true);
    const after = readOmpMcpConfig(f.configPath).doc;
    expect(after.mcpServers?.["notes-ompd"]).toMatchObject({ type: "http" });
    expect(after.disabledServers).toEqual(["vendor:notes"]);
  });

  test("the previous contents are kept once per apply", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f)]);
    expect(readFileSync(`${f.configPath}.bak`, "utf8")).toBe(POPULATED);
  });

  test("someone else's server under the brokered name is refused, not replaced", () => {
    const f = fixture(
      `${JSON.stringify({ mcpServers: { "notes-ompd": { type: "http", url: "https://not.ours/mcp" } } }, null, 2)}\n`,
    );
    const { token } = readOmpMcpConfig(f.configPath);
    expect(() => applyBrokeredServers(f.configPath, [entry(f)], token, { ownershipPath: f.ownershipPath })).toThrow(
      /ompd did not write/,
    );
    expect(readOmpMcpConfig(f.configPath).doc.mcpServers?.["notes-ompd"]).toEqual({
      type: "http",
      url: "https://not.ours/mcp",
    });
  });

  test("an owned name arriving with a different grant is a collision, not an update", () => {
    // How this happens in practice: broker names are minted by sanitizing the
    // original, so `a:b` and `a-b` both become `a-b`. Taking the second would
    // repoint the name and leave the first grant with an ownership record, a
    // disable, and no route to it.
    const f = fixture(POPULATED);
    const applied = applyFresh(f, [entry(f, { brokerName: "collides", originalName: "a:b" })]);
    if (!applied.written) throw new Error("expected the apply to land");

    expect(() =>
      applyBrokeredServers(
        f.configPath,
        [entry(f, { brokerName: "collides", originalName: "a-b", grantId: "mcpauth_aaaabbbbccccdddd" })],
        applied.token,
        { ownershipPath: f.ownershipPath },
      ),
    ).toThrow(/already brokering grant mcpauth_0123456789abcdef/);

    // The first grant's entry and ownership are untouched.
    expect(readOmpMcpConfig(f.configPath).doc.mcpServers?.collides).toMatchObject({
      url: "http://127.0.0.1:8722/mcp/mcpauth_0123456789abcdef",
    });
    expect(readOwnership(f.ownershipPath).servers.collides).toEqual({
      originalName: "a:b",
      grantId: "mcpauth_0123456789abcdef",
    });
  });

  test("re-applying the same grant under the same name is still an update", () => {
    const f = fixture(POPULATED);
    const applied = applyFresh(f, [entry(f)]);
    if (!applied.written) throw new Error("expected the apply to land");
    const again = applyBrokeredServers(f.configPath, [entry(f, { port: 9100 })], applied.token, {
      ownershipPath: f.ownershipPath,
    });
    expect(again.written).toBe(true);
    expect(readOmpMcpConfig(f.configPath).doc.mcpServers?.["notes-ompd"]).toMatchObject({
      url: "http://127.0.0.1:9100/mcp/mcpauth_0123456789abcdef",
    });
  });
});

describe("a write that would clobber someone's edit", () => {
  test("a stale token refuses and hands back the current document", () => {
    const f = fixture(POPULATED);
    const { token: stale } = readOmpMcpConfig(f.configPath);

    // `/mcp add` lands while ompd is thinking.
    const meanwhile = JSON.parse(POPULATED) as { mcpServers: Record<string, unknown> };
    meanwhile.mcpServers.docs = { type: "http", url: "https://mcp.docs.test/mcp" };
    writeFileSync(f.configPath, `${JSON.stringify(meanwhile, null, 2)}\n`);

    const result = applyBrokeredServers(f.configPath, [entry(f)], stale, { ownershipPath: f.ownershipPath });
    expect(result.written).toBe(false);
    if (result.written) throw new Error("unreachable");
    expect(result.reason).toBe("stale");
    // Returned, not merely refused: the caller can fold the human's change in
    // without a second round trip to find out what changed.
    expect(Object.keys(result.current.mcpServers ?? {})).toContain("docs");
    expect(result.token).toBe(readOmpMcpConfig(f.configPath).token);

    // And nothing was written: the docs entry is still there, the brokered
    // entry is not, and no ownership was claimed.
    const after = readOmpMcpConfig(f.configPath).doc;
    expect(after.mcpServers?.docs).toBeDefined();
    expect(after.mcpServers?.["notes-ompd"]).toBeUndefined();
    expect(readOwnership(f.ownershipPath).servers).toEqual({});
  });

  test("the token a write returns is good enough for the next write with no re-read", () => {
    const f = fixture(POPULATED);
    const first = applyFresh(f, [entry(f)]);
    if (!first.written) throw new Error("expected the first apply to land");
    const second = applyBrokeredServers(f.configPath, [entry(f, { port: 9001 })], first.token, {
      ownershipPath: f.ownershipPath,
    });
    expect(second.written).toBe(true);
  });

  test("a removal against a stale token refuses too", () => {
    const f = fixture(POPULATED);
    const applied = applyFresh(f, [entry(f)]);
    if (!applied.written) throw new Error("expected the apply to land");
    writeFileSync(f.configPath, `${readFileSync(f.configPath, "utf8")}\n`);
    const result = removeBrokeredServers(f.configPath, ["notes-ompd"], applied.token, {
      ownershipPath: f.ownershipPath,
    });
    expect(result.written).toBe(false);
    expect(readOmpMcpConfig(f.configPath).doc.mcpServers?.["notes-ompd"]).toBeDefined();
  });
});

describe("the entry itself carries no credential", () => {
  test("the header is a !command and the token value is nowhere in the file bytes", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f)]);

    const written = readOmpMcpConfig(f.configPath).doc;
    const server = written.mcpServers?.["notes-ompd"] as { headers: Record<string, string>; url: string };
    expect(server.url).toBe("http://127.0.0.1:8722/mcp/mcpauth_0123456789abcdef");
    expect(server.headers[MCP_AUTH_HEADER]).toBe(`!/bin/cat ${f.tokenPath}`);

    // The bytes, not a redaction helper's opinion about them. And the token file
    // really does hold the secret, so a check that passes because the fixture
    // never had one would be caught here.
    expect(readFileSync(f.tokenPath, "utf8")).toContain(f.tokenValue);
    expect(readFileSync(f.configPath, "utf8")).not.toContain(f.tokenValue);
    expect(readFileSync(`${f.configPath}.bak`, "utf8")).not.toContain(f.tokenValue);
    expect(readFileSync(f.ownershipPath, "utf8")).not.toContain(f.tokenValue);
  });

  test("the reader is an absolute binary, because a launchd session has no useful PATH", () => {
    const f = fixture();
    applyFresh(f, [entry(f)]);
    const server = readOmpMcpConfig(f.configPath).doc.mcpServers?.["notes-ompd"] as {
      headers: Record<string, string>;
    };
    expect(server.headers[MCP_AUTH_HEADER]).toStartWith("!/");
  });

  test("a token path a shell would not read literally is refused", () => {
    const f = fixture();
    const { token } = readOmpMcpConfig(f.configPath);
    for (const bad of ["relative/mcp-auth.token", "/tmp/a b/token", "/tmp/$(id)/token", "/tmp/t;rm -rf /"]) {
      expect(() =>
        applyBrokeredServers(f.configPath, [entry(f, { tokenPath: bad })], token, {
          ownershipPath: f.ownershipPath,
        }),
      ).toThrow();
    }
    expect(existsSync(f.configPath)).toBe(false);
  });

  test("a brokered entry may not reuse the name it disables", () => {
    const f = fixture();
    const { token } = readOmpMcpConfig(f.configPath);
    expect(() =>
      applyBrokeredServers(f.configPath, [entry(f, { brokerName: "cld-notes", originalName: "cld-notes" })], token, {
        ownershipPath: f.ownershipPath,
      }),
    ).toThrow(/must not reuse/);
  });
});

describe("disabling the unbrokered copy", () => {
  test("the original name is added and pre-existing entries are kept", () => {
    const f = fixture(POPULATED);
    const result = applyFresh(f, [entry(f)]);
    if (!result.written) throw new Error("expected the apply to land");
    expect(result.disabled).toEqual(["vendor:notes"]);
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).toEqual([
      "something-the-operator-turned-off",
      "vendor:notes",
    ]);
  });

  test("a namespaced plugin name survives, since that is what real ones look like", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f, { brokerName: "bandwidth-ompd", originalName: "vendor-carrier:Bandwidth" })]);
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).toContain("vendor-carrier:Bandwidth");
  });

  test("an original name the operator had already disabled is not claimed as ours", () => {
    const f = fixture(`${JSON.stringify({ mcpServers: {}, disabledServers: ["vendor:notes"] }, null, 2)}\n`);
    const result = applyFresh(f, [entry(f)]);
    if (!result.written) throw new Error("expected the apply to land");
    expect(result.disabled).toEqual([]);
    expect(readOwnership(f.ownershipPath).disabled).toEqual({});
  });

  test("ownership is recorded outside the OMP config file", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f)]);
    // No new top-level key: a marker inside mcp.json would be an unknown
    // property in a file OMP validates against its own schema, and the failure
    // mode of tripping that is the whole file contributing nothing.
    expect(Object.keys(readOmpMcpConfig(f.configPath).doc)).toEqual([
      "$schema",
      "mcpServers",
      "disabledServers",
      "enabledServers",
    ]);
    expect(readOwnership(f.ownershipPath)).toEqual({
      version: 1,
      servers: { "notes-ompd": { originalName: "vendor:notes", grantId: "mcpauth_0123456789abcdef" } },
      disabled: { "vendor:notes": true },
    });
  });
});

describe("removal restores what was there", () => {
  test("the brokered entry and only our own disable go away", () => {
    const f = fixture(POPULATED);
    const applied = applyFresh(f, [entry(f)]);
    if (!applied.written) throw new Error("expected the apply to land");

    const result = removeBrokeredServers(f.configPath, ["notes-ompd"], applied.token, {
      ownershipPath: f.ownershipPath,
    });
    expect(result).toMatchObject({ written: true, removed: ["notes-ompd"], skipped: [] });

    // Byte for byte back to where it started, other than the reserialisation
    // this module does deliberately.
    expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toEqual(JSON.parse(POPULATED));
    expect(readOwnership(f.ownershipPath).servers).toEqual({});
  });

  test("a disable ompd did not add is left alone", () => {
    const f = fixture(
      `${JSON.stringify({ mcpServers: {}, disabledServers: ["vendor:notes", "someone-elses-server"] }, null, 2)}\n`,
    );
    const applied = applyFresh(f, [entry(f)]);
    if (!applied.written) throw new Error("expected the apply to land");
    removeBrokeredServers(f.configPath, ["notes-ompd"], readOmpMcpConfig(f.configPath).token, {
      ownershipPath: f.ownershipPath,
    });
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).toEqual(["vendor:notes", "someone-elses-server"]);
  });

  test("a name ompd never wrote is skipped rather than deleted", () => {
    const f = fixture(POPULATED);
    const { token } = readOmpMcpConfig(f.configPath);
    const result = removeBrokeredServers(f.configPath, ["github"], token, { ownershipPath: f.ownershipPath });
    expect(result).toMatchObject({ written: true, removed: [], skipped: ["github"] });
    expect(readOmpMcpConfig(f.configPath).doc.mcpServers?.github).toBeDefined();
  });

  test("two brokered entries sharing one original keep it disabled until both are gone", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [
      entry(f, { brokerName: "notes-ompd" }),
      entry(f, { brokerName: "notes-ompd-work", grantId: "mcpauth_fedcba9876543210" }),
    ]);
    removeBrokeredServers(f.configPath, ["notes-ompd"], readOmpMcpConfig(f.configPath).token, {
      ownershipPath: f.ownershipPath,
    });
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).toContain("vendor:notes");

    removeBrokeredServers(f.configPath, ["notes-ompd-work"], readOmpMcpConfig(f.configPath).token, {
      ownershipPath: f.ownershipPath,
    });
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).not.toContain("vendor:notes");
  });

  test("the second entry to claim a shared original arriving in a later apply holds it too", () => {
    // The same property as above, except the second entry finds the disable
    // already there. A claim recorded per entry rather than per name would read
    // this as inherited from someone else and release it on the first removal.
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f, { brokerName: "notes-ompd" })]);
    applyFresh(f, [entry(f, { brokerName: "notes-ompd-work", grantId: "mcpauth_fedcba9876543210" })]);

    removeBrokeredServers(f.configPath, ["notes-ompd"], readOmpMcpConfig(f.configPath).token, {
      ownershipPath: f.ownershipPath,
    });
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).toContain("vendor:notes");

    removeBrokeredServers(f.configPath, ["notes-ompd-work"], readOmpMcpConfig(f.configPath).token, {
      ownershipPath: f.ownershipPath,
    });
    expect(readOmpMcpConfig(f.configPath).doc.disabledServers).toEqual(["something-the-operator-turned-off"]);
  });
});

describe("the write itself", () => {
  test("no temp file is left behind, on the writing path or the throwing one", () => {
    const f = fixture(POPULATED);
    applyFresh(f, [entry(f)]);
    const { token } = readOmpMcpConfig(f.configPath);
    expect(() =>
      applyBrokeredServers(f.configPath, [entry(f, { port: -1 })], token, { ownershipPath: f.ownershipPath }),
    ).toThrow();

    const agentDir = join(f.configPath, "..");
    expect(readdirSync(agentDir).filter(name => name.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(join(f.ownershipPath, "..")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("two entries claiming one name is rejected before anything is written", () => {
    const f = fixture();
    const { token } = readOmpMcpConfig(f.configPath);
    expect(() =>
      applyBrokeredServers(f.configPath, [entry(f), entry(f, { grantId: "mcpauth_aaaabbbbccccdddd" })], token, {
        ownershipPath: f.ownershipPath,
      }),
    ).toThrow(/claim the name/);
    expect(existsSync(f.configPath)).toBe(false);
  });

  test("an mcpServers that is not an object is refused rather than overwritten", () => {
    const f = fixture(`${JSON.stringify({ mcpServers: ["not", "a", "map"] }, null, 2)}\n`);
    const { token } = readOmpMcpConfig(f.configPath);
    expect(() => applyBrokeredServers(f.configPath, [entry(f)], token, { ownershipPath: f.ownershipPath })).toThrow(
      /not an object/,
    );
  });
});

describe("finding OMP's config file", () => {
  test("the default is the user agent directory", () => {
    expect(ompMcpConfigPath({ env: { HOME: "/home/j" } })).toBe("/home/j/.omp/agent/mcp.json");
  });

  test("PI_CONFIG_DIR moves the whole config root", () => {
    expect(ompMcpConfigPath({ env: { HOME: "/home/j", PI_CONFIG_DIR: "/elsewhere/omp" } })).toBe(
      "/elsewhere/omp/agent/mcp.json",
    );
  });

  test("an active profile moves the user scope inside it", () => {
    // A profile sees only its own user-level servers, so writing the brokered
    // entry to the default profile's file while a profile is active puts it
    // where no session will read it.
    expect(ompMcpConfigPath({ env: { HOME: "/home/j" }, profile: "work" })).toBe(
      "/home/j/.omp/profiles/work/agent/mcp.json",
    );
    expect(ompMcpConfigPath({ env: { HOME: "/home/j", OMP_PROFILE: "work" } })).toBe(
      "/home/j/.omp/profiles/work/agent/mcp.json",
    );
    expect(ompMcpConfigPath({ env: { HOME: "/home/j", PI_PROFILE: "default" } })).toBe("/home/j/.omp/agent/mcp.json");
  });
});
