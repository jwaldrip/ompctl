# 0003: the daemon owns MCP OAuth refresh

Status: accepted

## The problem, from this machine rather than from theory

OMP holds MCP OAuth credentials in `~/.omp/agent/agent.db`, keyed
`mcp_oauth:profile:<profile>:<url>`. On 2026-08-25 that table held 27 such rows.
Read-only inspection of a copy (no values printed, only field names, counts and
timestamps):

- **Nine rows carry only `{access, refresh, expires}`.** No `tokenUrl`, no
  `clientId`. OMP's refresh predicate is
  `Boolean(current.refresh && material?.tokenUrl)`
  (`@oh-my-pi/pi-coding-agent/src/mcp/manager.ts:1435`), and `material` falls
  back to the config's `auth` block, which plugin-provided definition-only
  entries do not have. Those nine cannot be refreshed by any OMP session. They
  expire and stay expired. Among them: notes, home-hub, chat.vendor.test,
  bandwidth, routers, tickets.
- **Five rows exist for one URL** (`mail.vendor.test`), four for another
  (`finance`). OMP's refresh lease table is keyed by credential *row* id
  (`auth_credential_refresh_leases.credential_id`), so two rows holding two
  members of one rotating family are not serialised against each other. One of
  those rows records exactly the expected consequence:
  `invalid_grant: Refresh token reuse detected; session revoked`.
- **Every one of those authorization servers advertises `refresh_token`.**
  Probed anonymously via RFC 9728 then RFC 8414: notes, tickets, edge,
  routers, bandwidth, chat.vendor.test, docs, design, transcripts, site-vendor all
  return `grant_types_supported` containing `refresh_token`, all expose a
  registration endpoint.

So the grants are renewable and the providers are willing. What is missing is a
single long-lived owner that keeps the material needed to renew them and is the
only thing that ever redeems one.

## The decision

`ompd` runs a loopback MCP auth broker.

```
  omp session ──HTTP──▶ 127.0.0.1:<broker port>/mcp/<grantId> ──HTTPS──▶ upstream MCP
                          │
                          ├─ injects Authorization: Bearer <access>   (memory only)
                          └─ refresh_token grant ──▶ token endpoint   (vault)
```

- Sessions connect to a stable loopback endpoint. They hold no upstream
  credential of any kind.
- The daemon injects the access token per request, refreshes ahead of expiry,
  and persists rotation atomically.
- Refresh tokens and client secrets are sealed with AES-256-GCM; the master key
  lives in the OS keychain, or libsecret, or a `0600` file, and which one is
  reported rather than assumed.

### Why a different URL is the load-bearing part

OMP binds a stored credential to a server *by URL*. A session pointed at
`http://127.0.0.1:<port>/mcp/<id>` resolves no stored credential, so it has
nothing to refresh and cannot race the daemon. This is not a convention the
daemon asks OMP to respect; it is a consequence of how OMP looks credentials up.

### What the daemon does not do

- **No keepalive by polling a provider's API.** Calling `tools/list` on a
  schedule to keep a session warm renews nothing and hides the failure until it
  matters. The only renewal mechanism here is the refresh grant.
- **No generic forward proxy.** One endpoint per registered grant, each pinned
  to one upstream URL, with an allowlist of MCP JSON-RPC methods. There is no
  route that takes a destination from the caller.
- **No silent ownership grab.** Importing an existing OMP credential copies it;
  OMP's row is never modified or deleted. When an `omp auth-broker serve` is
  listening, import refuses rather than creating a second refresher for one
  rotating family.

## States

`healthy`, `refreshing`, `degraded`, `reauth_required`, `no_refresh_grant`. The
last two are the ones that earn the design: a provider that never issued a
refresh token is reported as such and nothing pretends to fix it, and a
definitive `invalid_grant` stops retrying and asks for a person.

## What is stored, and where

| Value | Where | Survives restart |
| --- | --- | --- |
| refresh token | `~/.ompd/mcp-auth.db`, sealed | yes |
| client secret | `~/.ompd/mcp-auth.db`, sealed | yes |
| vault master key | OS keychain / libsecret / `0600` file | yes |
| access token | process memory | **no**, by design |
| loopback auth token | `~/.ompd/mcp-auth.token`, `0600` | yes |

An access token that outlived the process would be a credential on disk with no
reason to be there. The daemon re-mints one on first use.

## The one thing in MCP config

The entry the daemon writes carries a loopback URL and a header that is a
*command*, never a value:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8722/mcp/<grantId>",
  "headers": { "X-Ompd-Mcp-Auth": "!/bin/cat ~/.ompd/mcp-auth.token" }
}
```

`!command` header indirection is OMP's own documented mechanism
(`omp://mcp-config.md`, "Pre-connect env/header resolution"). No secret is in
the config file, and a config file committed to a repository by accident carries
nothing.

Writes to `~/.omp/agent/mcp.json` are read-merge-write against a content hash:
the whole file is replaced on write, so a partial edit would silently destroy
every other server the operator has configured.
