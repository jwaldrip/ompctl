/**
 * The vault, tested as the thing that either protects a refresh token or lies
 * about protecting it.
 *
 * Every test here forces a backend or supplies its own key provider. None of
 * them touch the developer's login keychain: a test suite that wrote to the
 * real keychain would be a test suite nobody could run twice on a locked
 * machine, and it would leave an item behind on a laptop that has real grants
 * in it. The keychain path is exercised by hand and its one measured surprise
 * -- `security` exiting 0 after storing an empty password -- is what the
 * read-back confirmation in `resolveMasterKey` exists to catch, and that
 * confirmation *is* covered here through a provider that accepts a key and
 * forgets it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  type CommandRunner,
  keychainProvider,
  libsecretProvider,
  type MasterKeyProvider,
  openVault,
} from "../src/mcpauth/vault.ts";

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ompd-mcpauth-vault-"));
  homes.push(home);
  return home;
}

/**
 * Replace the first character of one dot-separated envelope field.
 *
 * A byte-level edit rather than a truncation, because truncation is caught by
 * the length checks before the cipher is ever constructed, and it is the cipher
 * that has to reject this.
 */
function tamper(envelope: string, field: number): string {
  const parts = envelope.split(".");
  const target = parts[field] ?? "";
  parts[field] = (target.startsWith("A") ? "B" : "A") + target.slice(1);
  return parts.join(".");
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop() ?? "", { recursive: true, force: true });
});

describe("the envelope", () => {
  test("a sealed value opens again with the same aad", () => {
    const vault = openVault(freshHome(), { backend: "file" });
    const secret = `rt_${randomBytes(24).toString("hex")}`;
    expect(vault.open(vault.seal(secret, "mcpauth_deadbeefdeadbeef"), "mcpauth_deadbeefdeadbeef")).toBe(secret);
  });

  test("the envelope is versioned and carries four fields", () => {
    // Other slices read these blobs out of SQLite. The shape is a contract, and
    // a change to it has to be a version bump rather than a silent reinterpretation.
    const vault = openVault(freshHome(), { backend: "file" });
    const parts = vault.seal("value", "aad").split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  test("the plaintext is not in the envelope", () => {
    const vault = openVault(freshHome(), { backend: "file" });
    const secret = `rt_${randomBytes(24).toString("hex")}`;
    expect(vault.seal(secret, "aad")).not.toContain(secret);
  });

  test("sealing the same value twice produces different envelopes", () => {
    // A deterministic envelope would leak equality across rows: two grants
    // holding the same refresh token would be visibly identical in a database
    // an operator can read, which is exactly the fact the seal is hiding.
    const vault = openVault(freshHome(), { backend: "file" });
    expect(vault.seal("same", "aad")).not.toBe(vault.seal("same", "aad"));
  });
});

describe("an envelope that has been interfered with", () => {
  test("the wrong aad throws", () => {
    const vault = openVault(freshHome(), { backend: "file" });
    const envelope = vault.seal("secret", "mcpauth_aaaaaaaaaaaaaaaa");
    expect(() => vault.open(envelope, "mcpauth_bbbbbbbbbbbbbbbb")).toThrow();
  });

  test("a tampered ciphertext throws", () => {
    const vault = openVault(freshHome(), { backend: "file" });
    const envelope = vault.seal("secret", "aad");
    expect(() => vault.open(tamper(envelope, 3), "aad")).toThrow();
  });

  test("a tampered tag throws", () => {
    const vault = openVault(freshHome(), { backend: "file" });
    const envelope = vault.seal("secret", "aad");
    expect(() => vault.open(tamper(envelope, 2), "aad")).toThrow();
  });

  test("a tampered iv throws", () => {
    const vault = openVault(freshHome(), { backend: "file" });
    const envelope = vault.seal("secret", "aad");
    expect(() => vault.open(tamper(envelope, 1), "aad")).toThrow();
  });

  test("an unknown version prefix is refused as a version, not as a bad tag", () => {
    // The assertion is on *which* rejection, deliberately. GCM would refuse a
    // `v2.` envelope anyway, since the tag was computed over the fields the way
    // v1 lays them out, so a test that only asserted `toThrow()` would pass
    // with the version check deleted and would be evidence of nothing. The
    // check earns its place by making a future format change a readable error
    // instead of an authentication failure an operator would read as tampering.
    const vault = openVault(freshHome(), { backend: "file" });
    const envelope = vault.seal("secret", "aad");
    expect(() => vault.open(envelope.replace(/^v1\./, "v2."), "aad")).toThrow("mcp-auth vault: not a v1 envelope");
    expect(() => vault.open(envelope.slice(3), "aad")).toThrow("mcp-auth vault: not a v1 envelope");
  });

  test("a truncated field is refused before the cipher is built", () => {
    // A short iv or tag would otherwise reach `createDecipheriv`, which throws
    // its own error about an invalid initialization vector -- a message about
    // the wrong layer for what is a malformed envelope.
    const vault = openVault(freshHome(), { backend: "file" });
    const parts = vault.seal("secret", "aad").split(".");
    parts[1] = (parts[1] ?? "").slice(0, 8);
    expect(() => vault.open(parts.join("."), "aad")).toThrow("mcp-auth vault: malformed envelope");
  });

  test("a long plaintext with a broken tag yields nothing, not a prefix", () => {
    // GCM decrypts as a stream, so `update` hands back plaintext before the tag
    // is checked. An implementation that returned what `update` produced and
    // skipped `final` would pass every short-value test above by accident and
    // hand a caller an unauthenticated secret. This one is long enough that a
    // prefix would be recognisable.
    const vault = openVault(freshHome(), { backend: "file" });
    const secret = randomBytes(512).toString("hex");
    const envelope = vault.seal(secret, "aad");
    expect(() => vault.open(tamper(envelope, 2), "aad")).toThrow();
  });

  test("a failure names the failure and nothing else", () => {
    // These messages reach logs. An error carrying the envelope would put a
    // sealed secret in a log file, and one carrying the aad would name the
    // grant whose secret failed to open.
    const vault = openVault(freshHome(), { backend: "file" });
    const secret = `rt_${randomBytes(24).toString("hex")}`;
    const envelope = vault.seal(secret, "mcpauth_aaaaaaaaaaaaaaaa");
    try {
      vault.open(envelope, "mcpauth_bbbbbbbbbbbbbbbb");
      throw new Error("expected the wrong aad to be rejected");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      expect(message).toBe("mcp-auth vault: envelope failed authentication");
      expect(message).not.toContain(envelope);
      expect(message).not.toContain("mcpauth_aaaaaaaaaaaaaaaa");
    }
  });
});

describe("the file backend", () => {
  test("the key lands in the daemon home at 0600", () => {
    const home = freshHome();
    const vault = openVault(home, { backend: "file" });
    expect(vault.backend).toBe("file");

    // The path is spelled out rather than asked of the implementation. A test
    // that imported the path helper would still pass if the key moved.
    const stat = statSync(join(home, "mcp-auth.key"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("a restrictive umask does not decide the mode", () => {
    // This is what the `chmodSync` after the write is for. `writeFileSync`'s
    // `mode` is a request that the process umask can only narrow, so under a
    // umask that strips owner-write the key would land `0400` and the daemon
    // could never rewrite it. The chmod makes the permission exact rather than
    // whatever survived.
    // The home is made first, on purpose: a umask this narrow would also strip
    // the directory down to `0500` and the failure would be the harness's
    // rather than the vault's.
    const home = freshHome();
    const previous = process.umask(0o277);
    try {
      openVault(home, { backend: "file" });
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(home, "mcp-auth.key")).mode & 0o777).toBe(0o600);
  });

  test("a second vault on the same home opens the first one's envelopes", () => {
    // Restart survival at the vault layer. A vault that minted a new key per
    // process would pass every test above and lose every grant on every restart.
    const home = freshHome();
    const secret = `rt_${randomBytes(24).toString("hex")}`;
    const envelope = openVault(home, { backend: "file" }).seal(secret, "mcpauth_aaaaaaaaaaaaaaaa");

    expect(openVault(home, { backend: "file" }).open(envelope, "mcpauth_aaaaaaaaaaaaaaaa")).toBe(secret);
  });

  test("the key file holds a 32-byte key and nothing else", () => {
    const home = freshHome();
    openVault(home, { backend: "file" });
    const contents = readFileSync(join(home, "mcp-auth.key"), "utf8");
    expect(Buffer.from(contents.trim(), "base64")).toHaveLength(32);
  });

  test("a corrupt key file is an error, not a reason to mint a new key", () => {
    // Minting a replacement would leave every sealed row in the database
    // permanently unopenable, with no error at the moment it happened and no
    // way back. An operator deleting the file deliberately is the only path to
    // a new key, and it costs every grant a re-authorization.
    const home = freshHome();
    writeFileSync(join(home, "mcp-auth.key"), "not-a-key\n", { mode: 0o600 });
    expect(() => openVault(home, { backend: "file" })).toThrow(/32-byte base64 master key/);
  });
});

describe("a backend that cannot keep a key", () => {
  test("openVault throws rather than downgrading", () => {
    // The whole point of reporting a backend is that the report is true. A
    // vault that answered `keychain` while its key was in a flat file would be
    // read by an operator as protection it does not have. `security` makes this
    // reachable rather than theoretical: with `-w` reading stdin it exits 0
    // after storing an empty password when its two reads disagree.
    const forgetful: MasterKeyProvider = { backend: "keychain", load: () => undefined, store: () => {} };
    expect(() => openVault(freshHome(), { keyProvider: forgetful })).toThrow(/keychain/);
  });

  test("a backend that mangles the key on the way in throws", () => {
    // The mirror of the test above, for the failure that is not a total loss:
    // something stored, but not what was handed over.
    let held: Buffer | undefined;
    const mangling: MasterKeyProvider = {
      backend: "libsecret",
      load: () => held,
      store: key => {
        held = Buffer.concat([key.subarray(0, 31), Buffer.of(0)]);
      },
    };
    expect(() => openVault(freshHome(), { keyProvider: mangling })).toThrow(/libsecret/);
  });

  test("a provider that already holds a key is used as is, and reported", () => {
    // Without this, the two tests above would pass against a vault that simply
    // rejected every provider.
    const key = randomBytes(32);
    const provider: MasterKeyProvider = {
      backend: "libsecret",
      load: () => key,
      store: () => {
        throw new Error("should not be asked to store an existing key");
      },
    };
    const vault = openVault(freshHome(), { keyProvider: provider });
    expect(vault.backend).toBe("libsecret");
    expect(vault.open(vault.seal("secret", "aad"), "aad")).toBe("secret");
  });
});

/**
 * A runner that records what it was asked to do and answers from a script.
 *
 * The recording is the point for the argv tests: the claim being checked is
 * that the master key never appears in a command line, and the only way to
 * check that is to look at the command line.
 */
function fakeRunner(reply: (argv: string[]) => Partial<CommandResult>): {
  run: CommandRunner;
  calls: Array<{ argv: string[]; stdin?: string }>;
} {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const run: CommandRunner = (argv, stdin) => {
    const call: { argv: string[]; stdin?: string } = { argv };
    if (stdin !== undefined) call.stdin = stdin.toString();
    calls.push(call);
    return { exitCode: 0, stdout: "", stderr: "", ...reply(argv) };
  };
  return { run, calls };
}

describe("the keychain backend", () => {
  test("errSecItemNotFound is the only failure read as an absent key", () => {
    // This is the line that must never be wrong. A locked keychain reported as
    // absence mints a new key and overwrites the real one via `-U`, and every
    // grant on the machine is then unreadable with no error at the moment it
    // happened.
    const absent = fakeRunner(() => ({ exitCode: 44, stderr: "The specified item could not be found" }));
    expect(keychainProvider(absent.run).load()).toBeUndefined();

    const locked = fakeRunner(() => ({ exitCode: 36, stderr: "User interaction is not allowed" }));
    expect(() => keychainProvider(locked.run).load()).toThrow(/exit 36/);
  });

  test("an empty item reads as absent and a short one as an error", () => {
    // `security` stores an empty password when its two stdin reads disagree, so
    // an empty item is a real state rather than a hypothetical one.
    const empty = fakeRunner(() => ({ stdout: "\n" }));
    expect(keychainProvider(empty.run).load()).toBeUndefined();

    const short = fakeRunner(() => ({ stdout: `${Buffer.alloc(16).toString("base64")}\n` }));
    expect(() => keychainProvider(short.run).load()).toThrow(/32-byte base64 master key/);
  });

  test("a stored key comes back", () => {
    const key = randomBytes(32);
    const holding = fakeRunner(() => ({ stdout: `${key.toString("base64")}\n` }));
    expect(keychainProvider(holding.run).load()?.equals(key)).toBe(true);
  });

  test("the key is written to stdin and never to argv", () => {
    // `ps` shows one process's command line to every other process on the
    // machine, including other users'. A key passed as `-w <key>` would be
    // readable by anything running while the daemon started.
    const key = randomBytes(32);
    const encoded = key.toString("base64");
    const runner = fakeRunner(() => ({}));
    keychainProvider(runner.run).store(key);

    const call = runner.calls[0];
    expect(call?.argv.join(" ")).not.toContain(encoded);
    expect(call?.stdin).toBe(`${encoded}\n${encoded}\n`);
    // `-w` has to be last for `security` to prompt rather than take a value.
    expect(call?.argv.at(-1)).toBe("-w");
    // And `-A` is absent: it would open the item to every binary on the system.
    expect(call?.argv).not.toContain("-A");
  });

  test("a failed write throws", () => {
    const refusing = fakeRunner(() => ({ exitCode: 1, stderr: "could not be added" }));
    expect(() => keychainProvider(refusing.run).store(randomBytes(32))).toThrow(/exit 1/);
  });
});

describe("the libsecret backend", () => {
  test("an unreachable keyring is an error and an empty one is not", () => {
    // `secret-tool lookup` exits non-zero for both, so the distinction is the
    // diagnostic on stderr. Reading a broken D-Bus session as "no key yet"
    // would overwrite a live key the moment the session came back.
    const absent = fakeRunner(() => ({ exitCode: 1 }));
    expect(libsecretProvider(absent.run).load()).toBeUndefined();

    const broken = fakeRunner(() => ({ exitCode: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }));
    expect(() => libsecretProvider(broken.run).load()).toThrow(/D-Bus/);
  });

  test("a stored key comes back, and a short one is an error", () => {
    const key = randomBytes(32);
    const holding = fakeRunner(() => ({ stdout: key.toString("base64") }));
    expect(libsecretProvider(holding.run).load()?.equals(key)).toBe(true);

    const short = fakeRunner(() => ({ stdout: "c2hvcnQ=" }));
    expect(() => libsecretProvider(short.run).load()).toThrow(/32-byte base64 master key/);
  });

  test("the key is written to stdin and never to argv", () => {
    const key = randomBytes(32);
    const runner = fakeRunner(() => ({}));
    libsecretProvider(runner.run).store(key);

    const call = runner.calls[0];
    expect(call?.argv.join(" ")).not.toContain(key.toString("base64"));
    expect(call?.stdin).toBe(key.toString("base64"));
  });

  test("a failed write throws", () => {
    const refusing = fakeRunner(() => ({ exitCode: 1 }));
    expect(() => libsecretProvider(refusing.run).store(randomBytes(32))).toThrow(/exit 1/);
  });

  test("openVault drives a real backend end to end through the runner", () => {
    // The unit tests above prove each branch; this one proves they compose into
    // the shape `openVault` actually uses -- mint, store, read back, report.
    let held: string | undefined;
    const runner = fakeRunner(argv => {
      if (argv[1] === "store") return {};
      return held === undefined ? { exitCode: 1 } : { stdout: held };
    });
    const recording: CommandRunner = (argv, stdin) => {
      if (argv[1] === "store" && stdin !== undefined) held = stdin.toString();
      return runner.run(argv, stdin);
    };

    const vault = openVault(freshHome(), { keyProvider: libsecretProvider(recording) });
    expect(vault.backend).toBe("libsecret");
    expect(vault.open(vault.seal("secret", "aad"), "aad")).toBe("secret");
    expect(held).toBeDefined();
  });
});
