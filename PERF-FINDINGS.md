# Session open latency: measured baseline

Corpus measured: this machine's real `~/.omp/agent/sessions`, read-only, never mutated.
362 session files across 214 group directories, 631.6 MiB total.
Size distribution: min 544 B, p50 9.8 KiB, p90 2.6 MiB, p99 39 MiB, max 121 MiB.
69 files over 1 MiB, 19 over 8 MiB.

Harnesses (scratch, not product code): `scripts/bench-session-open.ts`,
`bench-path-for.ts`, `bench-yield-cost.ts`, `bench-pathfor-contention.ts`,
`bench-first-tap.ts`. All monotonic `performance.now()`, warm pass first, several
samples, bytes reported beside milliseconds.

## Not the bottleneck: transcript read and parse

`readSessionHistory` is already O(read window), not O(file). It reads a fixed
512 KiB window backwards from the cursor and walks lines to fill 30 turns.

| case | file | p50 | read | entries | payload |
| --- | --- | --- | --- | --- | --- |
| real p50 | 10 KiB | 0.07 ms | 10 KiB | 6 | 2 KiB |
| real p90 | 2.6 MiB | 1.43 ms | 512 KiB | 68 | 83 KiB |
| real p99 | 39 MiB | 1.28 ms | 512 KiB | 51 | 101 KiB |
| real max | 121 MiB | 1.17 ms | 512 KiB | 70 | 70 KiB |
| synthetic tool-heavy | 16 MiB | 0.59 ms | 512 KiB | 45 | 123 KiB |

`readSessionTail` is under 3 ms on every case including the 121 MiB file.

So a 121 MiB session's first page costs 1.2 ms. Pagination, streaming parse and
first-page size are all solving a problem that does not exist here.

One thing worth noting but not a latency bottleneck: the first page's payload
reaches 123 KiB on tool-heavy sessions, because `HISTORY_MAX_BYTES` is the read
window rather than a response cap. On localhost that is free; over a hub relay
it is not. Not the dominant cost, so not this change.

## The bottleneck: `SessionIndex.pathFor`

The gateway calls `await index.pathFor(sessionId)` before it reads a single byte,
on every `session_history` AND every `session_tail` frame.

Actual user path measured: fresh store, `query({includeArchived:true})` (what the
fleet list does), then the FIRST lookup for the top row, one sample per trial,
8 trials.

| stage | p50 | min | max |
| --- | --- | --- | --- |
| `pathFor`, first after index query | 67.2 ms | 66.5 | 86.7 |
| `pathFor`, second (a load-earlier press) | 67.8 ms | 65.1 | 82.9 |
| `pathFor` + first history page | 69.0 ms | 68.3 | 90.0 |

So ~97% of the daemon's session-open time is spent finding the file, not reading it.

### Mechanism, isolated

`findSessionFileIter` walks group directories with one `readdirSync` each and
returns early on a match. `pathFor` awaits `setImmediate` between every
directory.

| measurement | result |
| --- | --- |
| walk driven synchronously, late-directory id | 2.42 ms |
| same walk, one `setImmediate` per directory, idle loop | 2.59 ms |
| 214 bare `setImmediate`s, idle loop | 0.08 ms |
| single `existsSync` (what a cache hit would cost) | 0.001 ms |

On an idle loop the yields are free. The 67 ms appears when the loop is not
idle, which is exactly when a tap happens: `query()` starts a background warm
pass that counts messages for 362 files, yielding constantly, and each of
`pathFor`'s 214 turns then queues behind a slice of it. Cost is therefore
proportional to how deep the session's group sits in readdir order, and it is
paid again on every load-earlier press for the whole time the warm pass runs.

An earlier pass of mine reported a 90/14/1.6 ms gradient across "first/middle/last
row" and I read it as row position. It was not: it was time since the query, as
the warm pass drained. Recording the wrong reading too, because the corrected
method is the point.

### The fix this points at

Memoise session id to path on `SessionIndex`, validated with one `existsSync` on
hit and falling back to the full walk on miss or when the file has moved. That
turns 67 ms into 0.001 ms on the second and every subsequent open, and on the
first open of a session the app has already listed if the cache is seeded from
the index build, which already has every path in hand.

Secondary, cheap: yield every N directories rather than every one on the miss
path, which keeps the walk interruptible while cutting its exposure to loop
contention. `scanner.test.ts:513` asserts one step per directory and would need
updating to the bounded-steps contract it actually cares about.

Urgency note: the transcript-pagination worker is making load-earlier automatic
on scroll. That multiplies the number of `pathFor` calls per session, so this
cost gets worse before it gets better.

## Not yet measured

- App-side reducer and render cost for a 70-entry page, separated from
  simulator scheduling noise.
- Hub-relay path. Only the direct socket was exercised.
- `tap -> loading pane` wall clock on a device. The immediate-loading contract
  from #126/#128 makes it a local state commit, so it should be one frame, but
  that is inference, not measurement.
