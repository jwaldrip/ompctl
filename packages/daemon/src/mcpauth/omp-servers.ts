/**
 * Which name OMP already mounts a given MCP URL under.
 *
 * `apply` needs this and cannot derive it. A grant's identity is its resource
 * URL, but the thing that has to be shadowed in `disabledServers` is a *name*,
 * and the name lives in whichever of a dozen config sources defined the server:
 * a plugin's `.mcp.json`, `~/.claude.json`, a project file, OMP's own user
 * config. Guessing it from the hostname is how you end up with two copies of a
 * connector mounted and no explanation.
 *
 * `loadAllMCPConfigs` is OMP's own resolver and it does not connect to
 * anything: it reads every source in precedence order and returns the resolved
 * map. That is exactly the question being asked here, answered by the code that
 * owns the answer, so this cannot drift from what a session actually sees.
 */

import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";

/**
 * How a URL is compared between a stored grant and a config entry.
 *
 * Lowercased and stripped of a trailing slash, matching how OMP keys its own
 * credentials (`mcp_oauth:profile:<profile>:<url>`, lowercased). Query and
 * fragment are kept: several hosted MCP servers put a workspace or an API key
 * in the query, so two URLs differing only there are genuinely two servers.
 */
export function normalizeMcpUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

export interface OmpServerEntry {
  name: string;
  url: string;
  type: string;
}

/**
 * Every remote MCP server OMP would mount in `cwd`, by resolved name.
 *
 * stdio entries are dropped: they carry no URL, so nothing here can be brokered
 * for them and nothing should be disabled on their behalf.
 */
export async function listOmpRemoteServers(cwd: string): Promise<OmpServerEntry[]> {
  const { configs } = await loadAllMCPConfigs(cwd);
  const entries: OmpServerEntry[] = [];
  for (const [name, config] of Object.entries(configs)) {
    // `url` lives only on the http and sse variants of the union. Read it
    // structurally rather than by narrowing on `type`, because an entry whose
    // `type` OMP defaulted still carries the field that matters here.
    const url = "url" in config && typeof config.url === "string" ? config.url : undefined;
    if (url === undefined || url.length === 0) continue;
    entries.push({ name, url, type: "type" in config && typeof config.type === "string" ? config.type : "http" });
  }
  return entries;
}

/**
 * Broker names for a whole batch at once, guaranteed distinct.
 *
 * Two constraints come from OMP rather than from taste. Its bundled schema's
 * `propertyNames` pattern has no `:`, so a marketplace-style name like
 * `vendor:notes` cannot be reused as an `mcpServers` key even though the runtime
 * would accept it. And `disabledServers` outranks everything by name, so a
 * broker entry sharing the original's name would disable itself the moment the
 * original is shadowed.
 *
 * The reason this takes a batch rather than one name: sanitising `:` to `-` is
 * not injective. `vendor:notes` and `cld-notes` both sanitise to `cld-notes`,
 * and a per-name function cannot see the collision. The second one would
 * repoint the first one's entry at a different grant and leave the first
 * grant with an ownership record, a disable, and no route to itself. Unlikely
 * shape, silent failure, one line to prevent.
 */
export function mintBrokerNames(
  entries: ReadonlyArray<{ originalName: string; grantId: string }>,
): Array<{ originalName: string; grantId: string; brokerName: string }> {
  const claimed: Record<string, true> = {};
  return entries.map(entry => {
    const sanitized = entry.originalName.replace(/[^A-Za-z0-9_.-]/g, "-");
    let name = sanitized === entry.originalName ? `${sanitized}-ompd` : sanitized;
    // The grant id is derived from the resource URL, so the disambiguated name
    // is as stable as the name it disambiguates: re-applying produces the same
    // string rather than a second entry.
    if (claimed[name] === true) name = `${name}-${entry.grantId.slice(-6)}`;
    claimed[name] = true;
    return { originalName: entry.originalName, grantId: entry.grantId, brokerName: name };
  });
}
