/**
 * The vault that keeps `mcp-auth.db` from being a credential.
 *
 * Every other secret this daemon persists is stored as a hash, because it only
 * ever needs to be compared. A refresh token has to be *presented* again, so
 * the `auth_tokens` pattern does not apply and cannot be stretched to fit. What
 * is left is envelope encryption: AES-256-GCM per value, with the master key
 * held somewhere the database file is not.
 *
 * Be honest about the threat this addresses. A process already running as this
 * user can reach the keychain, libsecret, and the key file alike, so this is
 * not a defence against local code execution. What it stops is the database
 * *itself* being a credential: a Time Machine backup, a folder someone synced,
 * a `.db` copied into a bug report, a support bundle, a stray `SELECT *`. Those
 * are the ways a refresh token actually escapes a developer machine, and none
 * of them carry the master key.
 *
 * Which mechanism protected the bytes is reported, never assumed. A vault that
 * quietly downgraded from the keychain to a flat file would answer `keychain`
 * to `ompd mcp-auth status` while being a file, and an operator would make a
 * decision on it. So a backend that is selected and then fails is an error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretVault, VaultBackend } from "./types.ts";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The envelope is versioned in its first field so a future change of cipher or
 * KDF is a readable migration rather than a pile of undecryptable rows. An
 * unknown version is refused rather than guessed at.
 */
const ENVELOPE_VERSION = "v1";

const KEYCHAIN_SERVICE = "ai.ompctl.ompd";
const KEYCHAIN_ACCOUNT = "mcp-auth-master-key";
const KEYCHAIN_LABEL = "ompd MCP auth master key";

/** `security`'s exit code for errSecItemNotFound. The one non-zero exit that means "absent". */
const SECURITY_ITEM_NOT_FOUND = 44;

/**
 * Where a master key comes from and goes.
 *
 * A seam, so the tests that matter -- envelope integrity, AAD binding, at-rest
 * absence of the token in the database file -- run against a key this process
 * generated rather than against the developer's login keychain. It is also the
 * shape each real backend already has, so there is one code path rather than a
 * test-only branch inside the production one.
 */
export interface MasterKeyProvider {
  readonly backend: VaultBackend;
  /** The stored key, or `undefined` when this backend holds none yet. Throws when it holds something unusable. */
  load(): Buffer | undefined;
  /** Persist `key`. Throws rather than returning a failure: the caller has no weaker option to fall back to. */
  store(key: Buffer): void;
}

export interface OpenVaultOptions {
  /** Force a backend instead of probing for the strongest available one. */
  backend?: VaultBackend;
  /** Replace key storage wholesale. Tests pass one; the daemon does not. */
  keyProvider?: MasterKeyProvider;
}

/**
 * Open the vault for a daemon home, minting a master key the first time.
 *
 * Synchronous on purpose. Sealing and opening happen inside SQLite
 * transactions in `McpAuthStore`, and a vault whose key arrived on a promise
 * would either have to be awaited inside a transaction or cached somewhere the
 * transaction could not see it.
 */
export function openVault(home: string, opts: OpenVaultOptions = {}): SecretVault {
  const provider = opts.keyProvider ?? selectProvider(home, opts.backend);
  const key = resolveMasterKey(provider);

  return {
    backend: provider.backend,
    seal: (plaintext, aad) => seal(key, plaintext, aad),
    open: (envelope, aad) => openEnvelope(key, envelope, aad),
  };
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * `v1.<iv>.<tag>.<ciphertext>`, each field base64url.
 *
 * `aad` is authenticated but not stored, so it has to be supplied again to
 * open. `McpAuthStore` passes the grant id, which is what makes a sealed blob
 * copied from one row into another useless: the tag was computed over an id the
 * new row does not have.
 */
function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt an envelope, or throw.
 *
 * GCM is a stream cipher underneath, so `update` hands back plaintext *before*
 * the tag has been checked. The pieces are therefore accumulated and only
 * decoded to a string once `final` has returned, so a tampered envelope yields
 * an exception and never a prefix of the real value. Returning a partially
 * authenticated secret would be worse than returning nothing.
 *
 * The message names the failure and nothing else. No envelope, no aad, no
 * plaintext, no key: this string reaches logs.
 */
function openEnvelope(key: Buffer, envelope: string, aad: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("mcp-auth vault: not a v1 envelope");
  }

  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("mcp-auth vault: malformed envelope");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("mcp-auth vault: envelope failed authentication");
  }
  return plaintext.toString("utf8");
}

// ---------------------------------------------------------------------------
// Master key backends
// ---------------------------------------------------------------------------

/**
 * Pick the strongest backend whose tool is actually present.
 *
 * Probing for availability is not the same thing as downgrading. This runs
 * before a backend is chosen, and whatever it chooses is what gets reported.
 * Once chosen, a failure throws -- see `resolveMasterKey`.
 */
function selectProvider(home: string, forced?: VaultBackend): MasterKeyProvider {
  if (forced === "keychain") return keychainProvider();
  if (forced === "libsecret") return libsecretProvider();
  if (forced === "file") return fileProvider(home);

  if (process.platform === "darwin" && Bun.which("security") !== null) return keychainProvider();
  if (Bun.which("secret-tool") !== null) return libsecretProvider();
  return fileProvider(home);
}

/**
 * Load the master key, generating one on first run.
 *
 * The generated key is confirmed by reading it back, not by the absence of an
 * error, because at least one backend lies. `security add-generic-password`
 * with `-w` reads the value from stdin and asks for a retype; when the two
 * reads disagree it reprompts, hits EOF, stores an *empty* password, and exits
 * 0 (observed on macOS 15 on this machine). A vault that trusted that exit code
 * would report `keychain` while the keychain held nothing, and every row sealed
 * in that session would be unopenable after the next restart.
 *
 * A backend that cannot store is an error, never a reason to try a weaker one.
 * Silently becoming a file vault while answering `keychain` is precisely the
 * shape of lie the rest of this daemon refuses to tell.
 */
function resolveMasterKey(provider: MasterKeyProvider): Buffer {
  const existing = provider.load();
  if (existing !== undefined) return existing;

  const key = randomBytes(KEY_BYTES);
  provider.store(key);

  const confirmed = provider.load();
  if (confirmed === undefined || !confirmed.equals(key)) {
    throw new Error(
      `mcp-auth vault: the ${provider.backend} backend accepted a master key and did not return it. ` +
        `Refusing to continue with a weaker backend: a vault reported as ${provider.backend} has to be ${provider.backend}.`,
    );
  }
  return key;
}

/** Reject anything that is not exactly a 32-byte key, without echoing it. */
function decodeKey(encoded: string, source: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `mcp-auth vault: ${source} does not hold a ${KEY_BYTES}-byte base64 master key. ` +
        `Refusing to mint a replacement, which would make every stored grant unreadable; ` +
        `remove it deliberately to start over, and every grant will need re-authorizing.`,
    );
  }
  return key;
}

/**
 * How the two OS-tool backends shell out.
 *
 * A seam, because neither backend can otherwise be tested where it matters.
 * `secret-tool` does not exist on macOS at all, so the libsecret path would
 * ship with no coverage whatsoever; and the keychain path's most dangerous line
 * is its classification of a *failed* read, which cannot be provoked against a
 * real keychain without locking the developer's own. Both of those are the kind
 * of code that is wrong once and destroys every grant on the machine.
 *
 * `stdin` is `"ignore"` when no payload is supplied rather than inherited: a
 * daemon whose keychain read blocked on a prompt would hang at startup with
 * nothing on its terminal to explain why.
 */
export type CommandRunner = (argv: string[], stdin?: Buffer) => CommandResult;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const spawnRunner: CommandRunner = (argv, stdin) => {
  const proc = Bun.spawnSync(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

/**
 * macOS login keychain.
 *
 * The write feeds the key through stdin rather than argv. `-w` given as the
 * final option makes `security` prompt for the value and then for a retype, and
 * it reads both from stdin when stdin is not a terminal, so the key never
 * appears in a command line that `ps` shows to every process on the machine.
 * That was measured on this machine rather than assumed, because the obvious
 * form -- `-w <key>` -- does work and would have been argv-visible forever.
 *
 * Reading is already safe: `find-generic-password -w` writes the value to
 * stdout, which only this process holds.
 */
export function keychainProvider(run: CommandRunner = spawnRunner): MasterKeyProvider {
  const load = (): Buffer | undefined => {
    const found = run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    // Only errSecItemNotFound means "absent". A locked keychain, a denied ACL,
    // or a missing binary all fail differently, and treating any of them as
    // absence would mint a new key and overwrite the real one via `-U`, which
    // destroys every sealed row on the machine. So everything else throws.
    if (found.exitCode === SECURITY_ITEM_NOT_FOUND) return undefined;
    if (found.exitCode !== 0) {
      throw new Error(
        `mcp-auth vault: reading the master key from the login keychain failed with exit ${found.exitCode}. ` +
          `Not treating that as an absent key, which would overwrite it.`,
      );
    }
    const encoded = found.stdout.trim();
    if (encoded === "") return undefined;
    return decodeKey(encoded, `the login keychain item ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`);
  };

  const store = (key: Buffer): void => {
    const encoded = key.toString("base64");
    const written = run(
      [
        "security",
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-l",
        KEYCHAIN_LABEL,
        "-U",
        // Last, so `security` prompts and reads the value from stdin below.
        "-w",
      ],
      Buffer.from(`${encoded}\n${encoded}\n`),
    );
    // No `-A`. The item is created by `security`, which is therefore the
    // trusted application on its ACL, and reads through `security` need no
    // prompt -- verified on this machine. `-A` would have opened the item to
    // every binary on the system for no gain.
    if (written.exitCode !== 0) {
      throw new Error(
        `mcp-auth vault: storing the master key in the login keychain failed with exit ${written.exitCode}.`,
      );
    }
  };

  return { backend: "keychain", load, store };
}

/**
 * Linux libsecret, via `secret-tool`.
 *
 * `store` writes the secret to stdin for the same reason the keychain path
 * does. This machine is macOS, so unlike the keychain path nothing here was
 * measured against the real tool; what stands in for that is the runner seam
 * above, which lets the classification be tested, plus the read-back
 * confirmation in `resolveMasterKey`, which turns a write that landed wrong
 * into a startup error rather than a vault that cannot open its own rows.
 */
export function libsecretProvider(run: CommandRunner = spawnRunner): MasterKeyProvider {
  const load = (): Buffer | undefined => {
    const found = run(["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
    // `secret-tool lookup` exits non-zero with empty output when the item is
    // absent and prints a diagnostic when the collection cannot be reached, so
    // an unreachable keyring is distinguished from an empty one by stderr.
    if (found.exitCode !== 0) {
      const complaint = found.stderr.trim();
      if (complaint !== "") {
        throw new Error(`mcp-auth vault: reading the master key from libsecret failed: ${complaint}`);
      }
      return undefined;
    }
    const encoded = found.stdout.trim();
    if (encoded === "") return undefined;
    return decodeKey(encoded, `the libsecret item ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`);
  };

  const store = (key: Buffer): void => {
    const written = run(
      ["secret-tool", "store", `--label=${KEYCHAIN_LABEL}`, "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      Buffer.from(key.toString("base64")),
    );
    if (written.exitCode !== 0) {
      throw new Error(`mcp-auth vault: storing the master key in libsecret failed with exit ${written.exitCode}.`);
    }
  };

  return { backend: "libsecret", load, store };
}

/**
 * A `0600` file in the daemon home, which is already `0700`.
 *
 * The weakest of the three and the only one available everywhere. It still
 * separates the key from the database, which is the whole point: the two
 * travel together only if someone copies the entire home directory.
 */
function fileProvider(home: string): MasterKeyProvider {
  const path = join(home, "mcp-auth.key");

  const load = (): Buffer | undefined => {
    if (!existsSync(path)) return undefined;
    return decodeKey(readFileSync(path, "utf8").trim(), path);
  };

  const store = (key: Buffer): void => {
    writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
    // `mode` is masked by the process umask and ignored outright when the file
    // already exists, so the permission is asserted rather than requested --
    // the same reason `~/.ompd/identity` follows its write with a chmod.
    chmodSync(path, 0o600);
  };

  return { backend: "file", load, store };
}
