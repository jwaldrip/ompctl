# Routines over MCP

A routine is a trigger plus an ordered list of prompts. Until now the only
things that could define one were the phone app, over the websocket
(`routine_write`), and `/v1/sync/import`, which copies a whole configuration
from another daemon. Neither is reachable from a terminal, so the answer to
"schedule this" was always "open the app". `ompd mcp` closes that: a local
stdio MCP server, shipped inside the same compiled binary as the daemon, that
any OMP session can call.

## Why stdio, and why through HTTP

**Stdio, because there is nothing to reach across.** The server and the daemon
run on the same machine for the same operator. A listener would be a second
port to authenticate, firewall and audit for a caller that is already a child
process of the session that wants it. `ompd mcp` binds nothing; it speaks
JSON-RPC on the file descriptors OMP handed it and exits when they close.

**Through the daemon's HTTP gateway, not the store.** The tools call
`/v1/routines*` with the operator's bearer token, exactly as `ompd routines`
and the app do. Reaching into SQLite directly would have been shorter and
would have skipped the four things that actually matter: the scope check, the
audit row, the scheduler's own re-authorization on a fire, and the store lock
the running daemon holds. A second writer to that database is a corruption
waiting for a coincidence.

**The token is read at the point of use, never carried.** The tools reuse
`api()` from `packages/cli/src/client.ts`, which resolves the address
(`OMPD_URL`, then `~/.ompd/endpoint`, then config) and reads the 0600
`~/.ompd/token` on each call. No token is passed on argv, stored in the MCP
config, or written to stderr, and no port is hardcoded anywhere: a daemon
started on `--port 0` is still found through the endpoint file.

## The surface

Seven tools. The list is closed, asserted by a test against the live registry,
so a tool added later cannot appear in every OMP session as a side effect of
being written.

| Tool | Reads or writes | `destructiveHint` | `idempotentHint` |
| --- | --- | --- | --- |
| `ompctl_routines_list` | read | false | true |
| `ompctl_routine_get` | read | false | true |
| `ompctl_routine_create` | write | false | false |
| `ompctl_routine_update` | write | false | false |
| `ompctl_routine_delete` | write | **true** | true |
| `ompctl_routine_run` | write | **true** | false |
| `ompctl_routine_rotate_webhook_secret` | write | **true** | false |

`openWorldHint` is false on all seven. The daemon is one known local process
with a fixed contract, not an open-ended external service.

**Rotate is marked destructive on purpose.** It writes rather than deletes, but
the previous secret stops working the instant it returns and cannot be
recovered, so anything already holding that credential breaks. Annotating it
`false` because "it only creates a secret" would hide the one consequence a
human needs to approve.

**Run is marked destructive because nothing here can bound what it does.**
Firing a routine starts its prompts on this machine, each with a working
directory, so the run can delete files, push a branch, or call an external
service. `destructiveHint: false` means the tool performs only additive
updates, which is a claim about the prompts rather than about the call, and
this tool has no way to make it. The honest value is the one that makes a
client ask first. `openWorldHint` stays false: the tool talks to one known
local daemon, and what the prompts inside a run reach is not the tool's world.

**Update is not idempotent, because an action without an id is a new action.**
The daemon mints an action id on every write for any action that arrives
without one, so sending the same patch twice leaves a routine that is equal
field by field but whose action ids differ from the first call's, and past run
outcomes are keyed to the ids they were recorded against. A caller that carries
each action's existing `id`, which `ompctl_routine_get` reports, gets a write
it can repeat; a caller that omits them cannot retry safely, and the annotation
says so rather than promising a property the write does not have.

**Delete is annotated, not double-confirmed.** OMP's own approval gate is the
human boundary for a destructive tool call. A `confirm: true` argument on top
of it would be a second gate that the model fills in by itself, which teaches
people that passing gates is a formality. The description states plainly that
the call also destroys the routine's run history and its webhook credential;
the annotation carries the rest.

## What a run reports

`ompctl_routine_get` answers the routine plus its most recent runs, newest
first, clamped to `runLimit`. Each action outcome inside a run carries the
`sessionId` of the session its agent ran in, and each run carries
`linkedSessionCount`: how many distinct sessions that run created.

**A session id is a handle, not a credential.** It is the same id an ordinary
session open takes, and the ordinary opener decides what it can do from the
daemon's own session index. Resuming a dormant session needs `prompt` scope and
the daemon verifies the index row's cwd against the claim. A live TUI session is
not taken over: it is opened through `openCollab()`, whose gate is `read`, and
when that terminal cannot collaborate the app falls back to its local
view-and-steer surface. An owned live agent attaches through its existing read
path. So returning the id grants nothing a caller did not already have. That is
why it is not stripped the way a webhook `secretRef` is: withholding it would
cost someone the ability to look at what a run actually did while protecting
nothing. A run's action outcome carries no credential and no execution host, so
there is nothing else in that half of the response to strip.

**The count is distinct and non-blank, not the action count.** The scheduler
creates one agent per prompt action, so a two-action run is normally two
sessions. But an action refused before it reached an agent has no session, and
a run recorded before the daemon linked sessions has none at all. Counting
actions instead would tell a caller there is something to open when there is
not.

**Zero is a real answer, and it is not a backfill.** Run rows serialize their
action outcomes into a single column, so adding this field needed no schema
change and no migration, and no row already on disk was rewritten. Those runs
come back exactly as they were stored, with no `sessionId` key on any action
and a count of zero. Nothing infers a session id from an agent id.

The count is in the tool's text as well as its structured output, because the
text is what a model reads. A field that appeared only in `structuredContent`
is a field a caller has to already know to ask for.

**`ompctl_routines_list` reports nothing about runs, on purpose.** The daemon's
list route returns routines only, so a run fact in that summary would mean one
HTTP call per routine behind a tool whose whole shape is a single cheap GET, or
a count of zero for every routine whose runs were never fetched. The second is
worse than the first: it is indistinguishable from a routine that genuinely
produced none. Ask `ompctl_routine_get` for a routine you want the runs of.

## Omitted is not empty

`ompctl_routine_update` takes every field as optional and sends only the keys
the caller actually supplied. An absent key leaves the stored value alone; a
present key replaces it. So `labels: {}` clears every label and no `labels` key
at all preserves them. `actions` replaces the whole array rather than patching
members, because an ordered list has no stable per-index identity: an edit that
inserted one action would silently retarget every later one.

## What a caller may not say

Three fields of a routine are the daemon's and not a caller's.

**`id` and `createdAt` are minted at the write.** A create that accepted an id
could overwrite an unrelated routine by naming it, which is an update wearing a
create's name.

**`RoutineAction.host` is forced to local.** A host spec carries an image,
bind mounts and a network policy. Letting a routine definition name one turns
"schedule a prompt" into "mount any path on this machine, on a timer". The app
and `/v1/sync/import` already force local for the same reason, so this is
parity with every other write path rather than a narrowing unique to MCP.

**A webhook trigger names no `secretRef`.** The daemon mints it. Two routines
that shared a ref would share one credential row, so one secret would open both
endpoints and rotating either would silently break the other. Moving a
trigger off `webhook` deletes the credential row, because withdrawing the
capability is the point of that edit; moving onto `webhook` mints a fresh one;
editing a webhook routine without touching its trigger keeps the existing ref,
so a live endpoint URL and any secret already handed out keep working.

A `secretRef` is also stripped from every read. `ompctl_routine_get` and
`ompctl_routines_list` report `hasWebhookSecretRef` instead. An MCP result is
model-visible text that lands in a transcript, and a credential reference does
not belong in one. The secret value itself is returned by exactly one tool,
exactly once, and the daemon keeps only a SHA-256 hash of it.

## Deliberately not exposed

The daemon's HTTP surface is much wider than seven tools. These are the
candidates that were considered and left off, ranked by how much I would want
them next. Each is off because of what it would cost, not because it was
missed.

1. **Transcript reads** (`GET /v1/agents`, `/v1/tasks`, transcript tails).
   The most defensible next addition. Left off because it is a separate
   capability with its own shape, and a first write surface should not smuggle
   a read surface in beside it. What "why did last night's routine fail"
   needs is now mostly here without it: `ompctl_routine_get` reports each
   action's state, its error, and the `sessionId` it ran in, so the answer is
   one ordinary session open away. Reading that transcript's contents through
   a tool is the part still missing.
2. **Agent lifecycle** (`POST /v1/agents`, `DELETE /v1/agents/:id`,
   `/v1/agents/:id/prompt`). Real value, real blast radius: this is "spawn a
   coding agent anywhere on this machine with a prompt of your choosing".
   Wants its own design pass on host policy before a model can call it.
3. **Sync export and import** (`/v1/sync/export`, `/v1/sync/import`). Import
   replaces whole configuration in one call, which makes it a bulk overwrite
   of every routine at once. Nothing about the routine tools needs it.
4. **Settings** (`/v1/sync-settings`). Writing `policyMode` moves the bar every
   other scope is measured against. A tool that can loosen the policy governing
   its own approval gate is not a tool, it is a hole.
5. **Devices and pairing** (`/v1/pair`, `/v1/devices/*`, `/v1/tokens/rotate`).
   Mints and revokes credentials. Never worth exposing to a model.
6. **Host provisioning** (container create and destroy). Destroys running work
   and pulls images. No.
7. **A generic daemon call** (`ompctl_api_call` with a path and a body). The
   tempting one, and the worst: it would collapse all of the above into a
   single tool whose annotations could not be honest, because one call would be
   read-only and the next irreversible. There is no correct
   `destructiveHint` for a tool that can do anything.

There is no `--enable-write` flag. A single switch that turns on every write at
once is the thing this list exists to avoid, and the seven tools above are
enabled unconditionally because each one was chosen individually.

## Install

```
ompd self-install          # compile and place the binary, if not already done
ompd mcp install           # register it for every OMP session
```

`mcp install` writes one entry into OMP's global MCP config
(`~/.omp/agent/mcp.json`, or the active profile's copy when `OMP_PROFILE` is
set):

```json
{
  "mcpServers": {
    "ompctl": { "type": "stdio", "command": "/abs/path/to/ompd", "args": ["mcp"] }
  }
}
```

**The path is absolute because OMP spawns stdio servers without an interactive
shell.** A bare `ompd` resolves against whatever `PATH` the launching process
had, which under launchd is not the one a terminal has.

The install reads before it writes: every other server, `$schema`,
`enabledServers` and any unrelated `disabledServers` entry survive untouched, a
`.bak` is left beside the file the first time it is modified, and the write goes
through a temp file and a rename so a crash cannot leave a half-written config.
Running it twice reports that nothing changed. Unparsable existing JSON is a
refusal, not an overwrite: a config that cannot be read is not a config that is
safe to replace. If `disabledServers` named `ompctl`, the install removes it and
says so, because someone running `mcp install` is asking for the server to work.

A new session picks it up on start; a running one needs `/mcp reload`.

## Proving it

`bun run check:mcp` drives the compiled binary over raw stdio against a scratch
daemon on its own `OMPD_HOME`: `initialize`, `tools/list`, then create, read,
update, run, rotate and delete, asserting on daemon state at each step rather
than on a call having returned. Every routine it writes carries a unique marker
and the teardown sweeps by marker prefix, so an earlier failed run's orphans go
too.

**A green "Connected" in a client is not this.** It proves a process started
and answered `initialize`. It says nothing about whether a write lands, whether
the token works, or whether a stray line on stdout has corrupted the framing,
which is the failure this check exists to catch.
