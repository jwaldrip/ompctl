/**
 * Argv to a command object, and nothing else.
 *
 * Parsing is separated from doing so that every accepted and rejected spelling
 * can be asserted without a daemon, a socket, or a filesystem. No framework:
 * the grammar is a verb, some positionals, and a handful of flags, and a
 * dependency that turns that into configuration would be larger than the thing
 * it configures.
 */

import { type HostMount, SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ } from "@ompd/core";

/** Raised for anything the user could fix by retyping the line. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const KNOWN_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE];

/** Flags that take no value; anything else consumes the next token. */
const BOOLEAN_FLAGS: Record<string, true> = {
  foreground: true,
  help: true,
  version: true,
  "allow-source-path": true,
  container: true,
  "dry-run": true,
  force: true,
  json: true,
};

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "start"; host?: string; port?: number; foreground: boolean }
  | { kind: "status" }
  | { kind: "config"; action: "list" }
  | { kind: "config"; action: "get"; key: string }
  | { kind: "config"; action: "set"; key: string; value: string }
  | { kind: "pair"; name: string; scopes: string[] }
  | { kind: "approve"; code: string; scopes: string[] }
  | { kind: "invite"; name: string; scopes: string[] }
  | { kind: "devices" }
  | { kind: "revoke"; deviceId: string }
  | { kind: "rotate"; deviceId?: string }
  | { kind: "agents" }
  /**
   * `new` deliberately has no `image` field.
   *
   * `ompd new` is a client, not the daemon. It authenticates over the same
   * HTTP surface with the same kind of token and runs through the same
   * validator as any paired phone, so "it is the local CLI" is not a
   * statement about where an image came from. What makes an image trusted is
   * an operator editing the daemon's own config, which is a different act on
   * a different surface: `containerImage` in `<home>/config.json`.
   */
  | {
      kind: "new";
      cwd: string;
      name?: string;
      container: boolean;
      mounts?: HostMount[];
    }
  | { kind: "stop-agent"; agentId: string }
  | { kind: "prompt"; agentId: string; text: string }
  | { kind: "tui"; host?: string; port?: number; token?: string }
  | { kind: "routines" }
  | { kind: "run"; routineId: string }
  | { kind: "webhook-secret"; routineId: string }
  | { kind: "routine-delete"; routineId: string }
  | { kind: "sync-config"; targetUrl: string; token: string }
  | { kind: "mcp" }
  | { kind: "mcp-install" }
  | { kind: "audit"; limit: number }
  | { kind: "open" }
  | { kind: "self-install"; prefix?: string }
  | { kind: "doctor" }
  | { kind: "install"; prefix?: string; allowSourcePath: boolean }
  | { kind: "mcp-auth"; action: "status"; json: boolean }
  | { kind: "mcp-auth"; action: "login"; resourceUrl: string; name?: string }
  | { kind: "mcp-auth"; action: "import"; dryRun: boolean; force: boolean }
  | { kind: "mcp-auth"; action: "apply" }
  | { kind: "mcp-auth"; action: "unapply" }
  | { kind: "mcp-auth"; action: "refresh"; grantId: string }
  | { kind: "mcp-auth"; action: "logout"; grantId: string }
  | { kind: "uninstall" };

export const USAGE = `ompd - control plane for OMP agents

usage: ompd <command> [options]

setup
  self-install [--prefix D]
                          compile ompd and install it, default ~/.local/bin
  doctor                  check the install, the daemon, and this machine
  install [--prefix D] [--allow-source-path]
                          install and load the launchd agent
  uninstall               unload and remove the launchd agent

daemon
  start [--host H] [--port N] [--foreground]
                          run the daemon
  status                  is it running, what is it doing

config
  config                  print effective configuration, defaults merged with the file
  config get <key>        print one effective value
  config set <key> <value>
                          persist a value to <home>/config.json; validated the same way
                          the daemon validates it at its own startup

devices
  pair <name> [--scopes read,prompt]
                          begin pairing and print the code to approve
  approve <code> --scopes read,prompt,manage,approve
                          approve a pending pairing and print its token once
  invite <name> [--scopes read,prompt]
                          pair and approve in one step; prints the token and a QR code
  devices                 list paired devices
  revoke <deviceId>       revoke a device
  rotate [--device <id>]  replace a token; the old one stops working

agents
  agents                  list agents
  new <cwd> [--name N] [--container [--mounts P[:ro|rw],...]]
                          create an agent; --mounts only with --container.
                          The image is the daemon's containerImage config, not a flag
  stop-agent <id>         stop an agent
  prompt <id> <text>      send a prompt and wait for the turn to settle
  tui [--host H] [--port N] [--token T]
                          attach to a running ompd and view its live agents

routines
  routines                list routines
  run <routineId>         run a routine now
  routines webhook-secret <routineId>
                          replace a webhook secret and print the new value once
  routines delete <routineId>
                          delete a routine, its runs, and its webhook secret
  sync-config <target-url> --token <target-token>
                          import non-secret configuration from another daemon

mcp
  mcp                     serve the routines MCP server on stdio; OMP spawns this
  mcp install             register this binary as an MCP server for every OMP session

audit
  audit [--limit N]       recent privileged actions

mcp auth
  mcp-auth                print every brokered MCP grant and its state
  mcp-auth login <mcp-url> [--name N]
                          authorize a remote MCP server in a browser; the daemon keeps
                          the refresh token and no session ever sees one
  mcp-auth import [--dry-run] [--force]
                          copy grants OMP already holds; never modifies OMP's own store,
                          and refuses while an omp auth-broker is running
  mcp-auth apply          point OMP's MCP config at the loopback broker
  mcp-auth unapply        put OMP's MCP config back the way it was
  mcp-auth refresh <id>   redeem the refresh token now, ignoring backoff
  mcp-auth logout <id>    forget one grant and its refresh token

scopes: ${KNOWN_SCOPES.join(", ")}

The daemon binds loopback by default; change it with config set host <address> before
starting, or make it reachable from elsewhere with config set hubUrl wss://host. OMPD_URL
overrides where the CLI looks for it and OMPD_TOKEN overrides the token in ~/.ompd/token.`;

interface ParsedTokens {
  positional: string[];
  flags: Map<string, string | true>;
}

function splitTokens(argv: string[]): ParsedTokens {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    if (body.length === 0) {
      // A bare `--` would conventionally end flag parsing. Nothing here takes
      // a trailing free-form argument, so accepting it would only hide a typo.
      throw new UsageError("`--` on its own is not a flag");
    }

    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS[body] === true) {
      flags.set(body, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${body} needs a value`);
    }
    flags.set(body, value);
    i += 1;
  }

  return { positional, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} must be an integer, got ${raw}`);
  return value;
}

/**
 * `read,prompt` to a validated, deduplicated scope list.
 *
 * Unknown scopes are rejected rather than dropped. A typo that silently
 * granted less than the operator asked for produces a device that fails later,
 * somewhere unrelated, for a reason nobody will connect to this line.
 */
export function parseScopes(raw: string): string[] {
  const parts = raw
    .split(",")
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (parts.length === 0) throw new UsageError("--scopes was empty");

  const unknown = parts.filter(part => !KNOWN_SCOPES.includes(part));
  if (unknown.length > 0) {
    throw new UsageError(`unknown scope ${unknown.join(", ")}; known scopes are ${KNOWN_SCOPES.join(", ")}`);
  }
  return [...new Set(parts)];
}

/**
 * `/data:ro,/tools:rw` to a validated mount list. A bare path with no suffix
 * defaults to read-only downstream; the mode is only ever written here when
 * the operator actually typed one, so "default" stays one decision in one
 * place rather than two that could drift apart.
 */
export function parseMounts(raw: string): HostMount[] {
  const parts = raw
    .split(",")
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (parts.length === 0) throw new UsageError("--mounts was empty");

  return parts.map(part => {
    const match = /^(.+):(ro|rw)$/.exec(part);
    if (match !== null) return { hostPath: match[1] as string, mode: match[2] as "ro" | "rw" };
    if (part.includes(":")) {
      throw new UsageError(`--mounts entry ${JSON.stringify(part)} has an unknown mode; use :ro or :rw`);
    }
    return { hostPath: part };
  });
}

function requirePositional(positional: string[], index: number, label: string): string {
  const value = positional[index];
  if (value === undefined) throw new UsageError(`missing <${label}>`);
  return value;
}

function rejectExtra(positional: string[], allowed: number, verb: string): void {
  if (positional.length > allowed) {
    throw new UsageError(`${verb} takes ${allowed} argument${allowed === 1 ? "" : "s"}`);
  }
}

export function parseCommand(argv: string[]): Command {
  const { positional, flags } = splitTokens(argv);
  const verb = positional[0];

  // `--version` before the bare-invocation fallback. Both are flags with no
  // verb beside them, so checking "no verb means help" first would answer
  // `ompd --version` with the usage text, which is what every installer, every
  // package manager, and `ompd doctor` all read to learn the version.
  if (flags.get("version") === true || verb === "version") return { kind: "version" };
  if (flags.get("help") === true || verb === undefined || verb === "help") return { kind: "help" };

  const rest = positional.slice(1);

  switch (verb) {
    case "start": {
      rejectExtra(rest, 0, "start");
      const port = numberFlag(flags, "port");
      if (port !== undefined && (port < 0 || port > 65_535)) {
        throw new UsageError(`--port must be between 0 and 65535, got ${port}`);
      }
      return {
        kind: "start",
        host: stringFlag(flags, "host"),
        port,
        foreground: flags.get("foreground") === true,
      };
    }

    case "status":
      rejectExtra(rest, 0, "status");
      return { kind: "status" };

    case "config": {
      const sub = rest[0];
      if (sub === undefined) {
        rejectExtra(rest, 0, "config");
        return { kind: "config", action: "list" };
      }
      if (sub === "get") {
        const configArgs = rest.slice(1);
        rejectExtra(configArgs, 1, "config get");
        return { kind: "config", action: "get", key: requirePositional(configArgs, 0, "key") };
      }
      if (sub === "set") {
        const configArgs = rest.slice(1);
        rejectExtra(configArgs, 2, "config set");
        return {
          kind: "config",
          action: "set",
          key: requirePositional(configArgs, 0, "key"),
          value: requirePositional(configArgs, 1, "value"),
        };
      }
      throw new UsageError(`unknown config action ${sub}; use config, config get <key>, or config set <key> <value>`);
    }

    case "pair": {
      rejectExtra(rest, 1, "pair");
      const scopes = stringFlag(flags, "scopes");
      return {
        kind: "pair",
        name: requirePositional(rest, 0, "name"),
        // Only used to print the approve line the operator runs next. Nothing
        // a pairing client asks for reaches the device row, which is the
        // property that keeps pairing from being a self-service grant.
        scopes: scopes === undefined ? [SCOPE_READ, SCOPE_PROMPT] : parseScopes(scopes),
      };
    }

    case "approve": {
      rejectExtra(rest, 1, "approve");
      const code = requirePositional(rest, 0, "code");
      const scopes = stringFlag(flags, "scopes");
      // Required, unlike on `pair`. This is the line that actually grants
      // authority, and a default grant is one nobody chose.
      if (scopes === undefined) throw new UsageError("approve needs --scopes");
      return { kind: "approve", code, scopes: parseScopes(scopes) };
    }

    case "invite": {
      rejectExtra(rest, 1, "invite");
      const scopes = stringFlag(flags, "scopes");
      return {
        kind: "invite",
        name: requirePositional(rest, 0, "name"),
        // Same default as `pair`: the least useful grant that still lets a
        // fresh device do something, since nobody explicitly chose it here.
        scopes: scopes === undefined ? [SCOPE_READ, SCOPE_PROMPT] : parseScopes(scopes),
      };
    }

    case "devices":
      rejectExtra(rest, 0, "devices");
      return { kind: "devices" };

    case "revoke":
      rejectExtra(rest, 1, "revoke");
      return { kind: "revoke", deviceId: requirePositional(rest, 0, "deviceId") };

    case "rotate": {
      rejectExtra(rest, 0, "rotate");
      // A flag rather than a positional, so the bare form is unambiguously
      // "rotate the credential I am holding" and cannot be a mistyped device
      // id that silently rotates the wrong one.
      const deviceId = stringFlag(flags, "device");
      return deviceId === undefined ? { kind: "rotate" } : { kind: "rotate", deviceId };
    }

    case "agents":
      rejectExtra(rest, 0, "agents");
      return { kind: "agents" };

    case "new": {
      rejectExtra(rest, 1, "new");
      const container = flags.get("container") === true;
      const mountsRaw = stringFlag(flags, "mounts");
      // Named rather than swept up by the unknown-flag path, because someone
      // typing `--image` had a working flag yesterday and deserves the reason
      // and the replacement, not "unknown flag". `ompd new` is a client: it
      // goes through the same gateway validator as any paired device, and
      // being local is not a statement about where an image came from.
      if (stringFlag(flags, "image") !== undefined) {
        throw new UsageError(
          "--image is gone. Naming a container image is daemon-local supply-chain approval and an API client " +
            'is not that, so the daemon refuses host.image on the wire. Set "containerImage" in the daemon\'s ' +
            "config.json, on the machine that will run it, and check it with `ompd doctor`.",
        );
      }
      if (!container && mountsRaw !== undefined) throw new UsageError("--mounts needs --container");
      return {
        kind: "new",
        cwd: requirePositional(rest, 0, "cwd"),
        name: stringFlag(flags, "name"),
        container,
        mounts: mountsRaw === undefined ? undefined : parseMounts(mountsRaw),
      };
    }

    case "stop-agent":
      rejectExtra(rest, 1, "stop-agent");
      return { kind: "stop-agent", agentId: requirePositional(rest, 0, "id") };

    case "prompt": {
      const agentId = requirePositional(rest, 0, "agentId");
      // Joined rather than capped at one positional, so an unquoted prompt is
      // sent as written instead of rejected for having spaces in it.
      const text = rest.slice(1).join(" ");
      if (text.length === 0) throw new UsageError("prompt needs text to send");
      return { kind: "prompt", agentId, text };
    }

    case "tui": {
      rejectExtra(rest, 0, "tui");
      const port = numberFlag(flags, "port");
      if (port !== undefined && (port < 0 || port > 65_535)) {
        throw new UsageError(`--port must be between 0 and 65535, got ${port}`);
      }
      return {
        kind: "tui",
        host: stringFlag(flags, "host"),
        port,
        token: stringFlag(flags, "token"),
      };
    }

    case "routines": {
      const action = rest[0];
      if (action === undefined) return { kind: "routines" };
      if (action !== "webhook-secret" && action !== "delete") {
        throw new UsageError(
          `unknown routines action ${action}; use routines, routines webhook-secret <routineId>, or routines delete <routineId>`,
        );
      }
      const args = rest.slice(1);
      rejectExtra(args, 1, `routines ${action}`);
      return action === "delete"
        ? { kind: "routine-delete", routineId: requirePositional(args, 0, "routineId") }
        : { kind: "webhook-secret", routineId: requirePositional(args, 0, "routineId") };
    }

    case "run":
      rejectExtra(rest, 1, "run");
      return { kind: "run", routineId: requirePositional(rest, 0, "routineId") };

    case "sync-config": {
      rejectExtra(rest, 1, "sync-config");
      const token = stringFlag(flags, "token");
      if (token === undefined) throw new UsageError("sync-config needs --token");
      return { kind: "sync-config", targetUrl: requirePositional(rest, 0, "target-url"), token };
    }

    case "mcp": {
      const action = rest[0];
      if (action === undefined) return { kind: "mcp" };
      if (action !== "install") {
        throw new UsageError(`unknown mcp action ${action}; use mcp or mcp install`);
      }
      rejectExtra(rest.slice(1), 0, "mcp install");
      return { kind: "mcp-install" };
    }

    case "audit": {
      rejectExtra(rest, 0, "audit");
      const limit = numberFlag(flags, "limit") ?? 50;
      if (limit <= 0) throw new UsageError(`--limit must be positive, got ${limit}`);
      return { kind: "audit", limit };
    }

    case "open":
      rejectExtra(rest, 0, "open");
      return { kind: "open" };

    case "self-install": {
      rejectExtra(rest, 0, "self-install");
      const prefix = stringFlag(flags, "prefix");
      return prefix === undefined ? { kind: "self-install" } : { kind: "self-install", prefix };
    }

    case "doctor":
      rejectExtra(rest, 0, "doctor");
      return { kind: "doctor" };

    case "install": {
      rejectExtra(rest, 0, "install");
      const prefix = stringFlag(flags, "prefix");
      // Opt-in rather than a prompt, because the thing being allowed is a
      // launch agent that quietly stops working when a directory is removed,
      // and nobody should be able to agree to that by pressing return.
      const allowSourcePath = flags.get("allow-source-path") === true;
      return prefix === undefined ? { kind: "install", allowSourcePath } : { kind: "install", prefix, allowSourcePath };
    }

    // Sub-verbs rather than seven top-level commands, because they share one
    // subject and reading `ompd mcp-auth` on its own should answer the only
    // question most runs have: which grants are alive.
    case "mcp-auth": {
      const action = rest[0];
      if (action === undefined) return { kind: "mcp-auth", action: "status", json: flags.get("json") === true };
      const args = rest.slice(1);
      switch (action) {
        case "status":
          rejectExtra(args, 0, "mcp-auth status");
          return { kind: "mcp-auth", action: "status", json: flags.get("json") === true };
        case "login": {
          rejectExtra(args, 1, "mcp-auth login");
          const name = stringFlag(flags, "name");
          const resourceUrl = requirePositional(args, 0, "mcp-url");
          return name === undefined
            ? { kind: "mcp-auth", action: "login", resourceUrl }
            : { kind: "mcp-auth", action: "login", resourceUrl, name };
        }
        case "import":
          rejectExtra(args, 0, "mcp-auth import");
          return {
            kind: "mcp-auth",
            action: "import",
            dryRun: flags.get("dry-run") === true,
            force: flags.get("force") === true,
          };
        case "apply":
          rejectExtra(args, 0, "mcp-auth apply");
          return { kind: "mcp-auth", action: "apply" };
        case "unapply":
          rejectExtra(args, 0, "mcp-auth unapply");
          return { kind: "mcp-auth", action: "unapply" };
        case "refresh":
          rejectExtra(args, 1, "mcp-auth refresh");
          return { kind: "mcp-auth", action: "refresh", grantId: requirePositional(args, 0, "grantId") };
        case "logout":
          rejectExtra(args, 1, "mcp-auth logout");
          return { kind: "mcp-auth", action: "logout", grantId: requirePositional(args, 0, "grantId") };
        default:
          throw new UsageError(
            `unknown mcp-auth action ${action}; use status, login, import, apply, unapply, refresh, or logout`,
          );
      }
    }

    case "uninstall":
      rejectExtra(rest, 0, "uninstall");
      return { kind: "uninstall" };

    default:
      throw new UsageError(`unknown command ${verb}`);
  }
}
