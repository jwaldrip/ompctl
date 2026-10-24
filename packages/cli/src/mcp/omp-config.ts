/**
 * Registering ompd in omp's MCP config, without becoming the reason someone's
 * config stopped working.
 *
 * The file this writes is not ours. `~/.omp/agent/mcp.json` is omp's, it is
 * hand-edited, and it holds other people's servers along with credentials
 * inside their URLs. So the decision and the write are split in two here. The
 * planner is pure: it takes the bytes that are on disk and returns the exact
 * document that should replace them, which means every no-clobber property
 * below can be asserted without a filesystem, and asserted on the real shape
 * of a real config rather than on a fixture invented to pass.
 *
 * Three rules come out of that file not being ours. Only the `ompctl` entry is
 * ompd's to write, so everything else is carried across untouched, including
 * keys this version has never heard of. A file that cannot be parsed is a hard
 * refusal rather than a fresh start, because "I could not read your config" is
 * not a reason to replace it. And a `disabledServers` entry naming us is
 * removed loudly, since that list wins over every registration: leaving it
 * would produce an install that reads as done and does nothing, which is the
 * one outcome worse than failing.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The name ompd registers itself under inside `mcpServers`. */
export const OMP_MCP_SERVER_NAME = "ompctl";

/** The argv omp spawns to get a routines server talking JSON-RPC on stdio. */
const SERVE_ARGS: readonly string[] = ["mcp"];

const MCP_CONFIG_NAME = "mcp.json";

/**
 * The `$schema` omp's own config carries, written only into a file this
 * command creates. An existing file keeps whatever it already had: a schema
 * URL is a statement about which omp wrote the file, and overwriting it would
 * be ompd answering a question it was not asked.
 */
const MCP_SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/**
 * The entry as omp's schema wants it. `type` is spelled out rather than left
 * to default, so a reader of the config can see it is a spawned process and
 * not an HTTP endpoint without knowing what the default is.
 */
interface OmpStdioServer {
  type: "stdio";
  command: string;
  args: string[];
}

export interface OmpMcpInstallPlan {
  path: string;
  changed: boolean;
  /** The exact JSON to write. Meaningless when `changed` is false. */
  document: unknown;
  /** Human lines the command prints, in the order it should print them. */
  notes: string[];
}

/**
 * Where omp reads its global MCP config.
 *
 * `PI_CODING_AGENT_DIR` first, for the same reason `agentDir` in
 * omp-extension.ts honours it: omp reads its config out of the active agent
 * directory, so writing to `~/.omp/agent` while omp runs from somewhere else
 * registers a server nothing will ever spawn.
 *
 * Then `OMP_PROFILE`, which moves the whole directory under `profiles/`. This
 * reads the profile of the shell running `ompd mcp install`, which is the only
 * profile this command can know about; a session started later under a
 * different one needs its own install.
 *
 * `home` is a parameter rather than a `homedir()` call so a test can install
 * into a temp tree, matching `plistPath` and `defaultPrefix`.
 */
export function ompMcpConfigPath(env: Record<string, string | undefined>, home: string): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured !== undefined && configured.length > 0) return join(configured, MCP_CONFIG_NAME);

  const profile = env.OMP_PROFILE;
  const agent =
    profile === undefined || profile.length === 0
      ? join(home, ".omp", "agent")
      : join(home, ".omp", "profiles", profile, "agent");
  return join(agent, MCP_CONFIG_NAME);
}

/**
 * What the config should say, given what it says now.
 *
 * `existing` is the file's bytes, or null when there is no file. Nothing here
 * touches the disk, so the whole decision is one function call in a test.
 */
export function planOmpMcpInstall(input: {
  existing: string | null;
  path: string;
  command: string;
}): OmpMcpInstallPlan {
  const desired: OmpStdioServer = { type: "stdio", command: input.command, args: [...SERVE_ARGS] };

  if (input.existing === null) {
    return {
      path: input.path,
      changed: true,
      document: { $schema: MCP_SCHEMA_URL, mcpServers: { [OMP_MCP_SERVER_NAME]: desired } },
      notes: [`registered ${OMP_MCP_SERVER_NAME}; omp had no MCP config here before`],
    };
  }

  const root = parseConfig(input.existing, input.path);
  const servers = readServers(root, input.path);
  const notes: string[] = [];
  let changed = false;

  const previous = servers[OMP_MCP_SERVER_NAME];
  if (previous === undefined) {
    // The count is printed because it is the property an operator actually
    // wants confirmed: their other servers are still there.
    const others = Object.keys(servers).length;
    const kept =
      others === 0
        ? ""
        : others === 1
          ? "; the server already here was left alone"
          : `; the ${String(others)} servers already here were left alone`;
    notes.push(`registered ${OMP_MCP_SERVER_NAME}${kept}`);
    changed = true;
  } else if (isDesiredEntry(previous, desired)) {
    notes.push(`${OMP_MCP_SERVER_NAME} already runs ${input.command}; nothing to change`);
  } else {
    // Both paths named, because the usual cause is a binary that moved and
    // the old path is the thing omp has been failing to spawn.
    notes.push(`${OMP_MCP_SERVER_NAME} was ${describeEntry(previous)}; it now runs ${input.command}`);
    changed = true;
  }

  // Spread rather than rebuilt: `$schema`, other servers, `enabledServers`,
  // and any key a later omp adds all survive, and they survive in the order
  // the operator's file had them, because an overwritten spread key keeps its
  // original position.
  const document: Record<string, unknown> = {
    ...root,
    mcpServers: { ...servers, [OMP_MCP_SERVER_NAME]: desired },
  };

  const disabled = readDisabledServers(root, input.path);
  if (disabled?.includes(OMP_MCP_SERVER_NAME)) {
    document.disabledServers = disabled.filter(entry => entry !== OMP_MCP_SERVER_NAME);
    notes.push(
      `${OMP_MCP_SERVER_NAME} was in disabledServers, which overrides every registration:`,
      "  it was configured and doing nothing. Removed, so this install is live.",
    );
    changed = true;
  }

  return { path: input.path, changed, document, notes };
}

/**
 * Put the plan on disk, or do nothing at all.
 *
 * An unchanged plan writes nothing: no rewrite, no backup, not even a
 * reformat. Running this command twice must leave the second run's config
 * byte-identical to the first's, so that "did something change" is answerable
 * by looking at the file.
 *
 * The write itself is a sibling and a rename, following config.ts: a
 * truncate-then-write has a window in which omp reads half a JSON object and
 * refuses to load any MCP server at all. A rename means the only two states a
 * reader can observe are the old config and the new one.
 */
export function applyOmpMcpInstall(plan: OmpMcpInstallPlan): void {
  if (!plan.changed) return;

  mkdirSync(dirname(plan.path), { recursive: true });

  // Read once, before anything is written, so a config the operator tightened
  // stays tightened.
  //
  // ENOENT is the only absence this may infer. An EACCES, EPERM or ELOOP here
  // would otherwise be read as "no file yet", which is the one reading that
  // skips the backup and then renames over whatever was really there. The
  // planner has already read this path successfully, so a different errno
  // means something changed underneath us and stopping is the only answer
  // that cannot destroy it.
  let existingMode: number | null = null;
  try {
    existingMode = statSync(plan.path).mode & 0o777;
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "ENOENT") {
      throw new Error(
        `cannot read ${plan.path} to back it up (${String(code ?? err)}); refusing to overwrite a config this command cannot copy first`,
      );
    }
    // No file yet. A new one starts at 0600 below, because omp's own config
    // holds server URLs with credentials embedded in them.
  }
  const mode = existingMode ?? 0o600;

  // Copied, not moved: omp keeps reading the real path until the rename
  // below, and the operator keeps a copy of what they had in case this
  // command's idea of the entry was wrong.
  //
  // Written through the same temp-and-rename dance as the config itself, for
  // two reasons a plain `copyFileSync` gets wrong. It would inherit whatever
  // mode a `.bak` already sitting there had, and on Linux `copyFileSync`
  // opens an existing destination `O_TRUNC` with the mode argument ignored,
  // so a loose-moded file planted at that name would keep its bits and hold a
  // copy of a config that carries credentials. And a copy straight to the
  // final name is readable half-written.
  if (existingMode !== null) writeBackup(plan.path, mode);

  const temp = `${plan.path}.${randomUUID()}.tmp`;
  try {
    // `wx` refuses to reuse a name, which with a random suffix means this
    // process is the only writer of this file.
    writeFileSync(temp, `${JSON.stringify(plan.document, null, 2)}\n`, { mode, flag: "wx" });
    renameSync(temp, plan.path);
    // Again after the rename: creation is masked by umask, and the renamed
    // file carries the temp's bits rather than the target's.
    chmodSync(plan.path, mode);
  } finally {
    // Unconditional. After a successful rename there is nothing at this path,
    // so a branch here could only ever forget a case.
    rmSync(temp, { force: true });
  }
}

/**
 * Copy `path` to `path.bak`, at exactly `mode`, without ever exposing a
 * partially written backup or inheriting the bits of a `.bak` that was already
 * there.
 *
 * Overwrites the previous backup, which is deliberate but worth knowing: this
 * is a copy of the config as it was immediately before the most recent change,
 * not an archive. Two installs in a row leave only the second one's input, so
 * it recovers a bad entry this command just wrote, not a config from last week.
 */
function writeBackup(path: string, mode: number): void {
  const backup = `${path}.bak`;
  const temp = `${backup}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, readFileSync(path), { mode, flag: "wx" });
    renameSync(temp, backup);
    chmodSync(backup, mode);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The refusal, as lines an operator can act on. Every one of these means the
 * file on disk is not something ompd can reason about, and the answer is
 * always the same: it is not ours, so a human decides.
 */
function refusal(path: string, why: string): string {
  return [
    `refusing to rewrite ${path}: ${why}.`,
    "  That is omp's MCP configuration, not ompd's, and a file ompd cannot read is not a file",
    "  ompd may replace. Fix or move it, then run `ompd mcp install` again.",
  ].join("\n");
}

function parseConfig(contents: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new Error(refusal(path, `it is not valid JSON (${err instanceof Error ? err.message : String(err)})`));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(refusal(path, "it does not hold a JSON object"));
  }
  return parsed as Record<string, unknown>;
}

function readServers(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const value = root.mcpServers;
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(refusal(path, "its mcpServers is not an object"));
  }
  return value as Record<string, unknown>;
}

/**
 * `disabledServers` as names, or null when the key is absent.
 *
 * A malformed list is a refusal rather than something to step around. omp
 * rejects the whole file over it, so registering into one would produce
 * exactly the silently-dead install the loud note above exists to prevent.
 */
function readDisabledServers(root: Record<string, unknown>, path: string): string[] | null {
  const value = root.disabledServers;
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(refusal(path, "its disabledServers is not a list"));

  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(refusal(path, "its disabledServers holds something that is not a name"));
    }
    names.push(entry);
  }
  return names;
}

/**
 * True only when the entry on disk is already exactly the one this command
 * would write. Extra keys count as a difference: the entry is ompd's whole
 * responsibility, and pretending an entry with an added `env` is ours would
 * mean `mcp install` reports nothing to do while omp spawns something else.
 */
function isDesiredEntry(value: unknown, desired: OmpStdioServer): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 3) return false;
  if (!("type" in value) || value.type !== "stdio") return false;
  if (!("command" in value) || value.command !== desired.command) return false;
  if (!("args" in value) || !Array.isArray(value.args)) return false;
  return value.args.length === desired.args.length && value.args.every((arg, index) => arg === desired.args[index]);
}

/** What the entry that is being replaced pointed at, for the note. */
function describeEntry(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("command" in value && typeof value.command === "string") return value.command;
    if ("url" in value && typeof value.url === "string") return value.url;
  }
  return "an entry ompd cannot describe";
}
