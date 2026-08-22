/**
 * Every OMP session ever run on this machine, not only the ones ompd
 * spawned: filesystem catalog (scanner.ts) plus decoded cwd (cwd-codec.ts)
 * plus verified liveness (liveness.ts) plus durable archive state (the
 * store), assembled into one queryable, sortable, groupable view.
 *
 * Rebuilt from the filesystem on every call. A session file can be appended
 * to or removed by the OMP TUI at any moment this daemon does not control,
 * so caching the assembled view itself would go stale under it; the only
 * thing cached across calls is the expensive part -- message counts, keyed
 * by mtime+size in the store -- which invalidates itself the instant a file
 * actually changes.
 *
 * The build never blocks the event loop for long and never blocks first
 * paint on a count:
 * - `build()` is async and cooperative: it yields while scanning, and the
 *   background warm pass streams transcript bytes off the event-loop thread
 *   and yields between files, so HTTP routes, websocket pings, and relay acks
 *   keep being served mid-build. A hub client's reconnect replay used to restart
 *   a multi-minute synchronous scan and starve even `/v1/health`; that
 *   failure mode is the reason this file is async at all.
 * - First paint serves every row immediately, with counts from the durable
 *   cache where they exist and `null` where they do not -- never a
 *   fabricated 0. Missing counts are warmed in the background, and
 *   `queryWithWarm` hands the caller a promise of upgraded rows for the one
 *   upgraded frame a socket client expects once they land.
 * - Single-flight: concurrent index requests (several clients, or one
 *   client's reconnect replay firing `listSessions` again) share one
 *   in-flight build and one in-flight warm pass. A reconnect loop cannot
 *   multiply the work it is reconnecting because of.
 */

import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import type { SessionScanCacheEntry, Store } from "@ompd/core";
import type {
  AgentId,
  SessionCwdScope,
  SessionDeleteResult,
  SessionGroup,
  SessionLiveStatus,
  SessionQuery,
  SessionSortDir,
  SessionSortKey,
  SessionSummary,
} from "@ompd/core/contracts";
import { TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import { listLiveClientPresences, runDaemonsRoot } from "./liveness.ts";
import {
  countMessagesAsync,
  findSessionFileIter,
  MESSAGE_COUNT_SIZE_CEILING_BYTES,
  type RawSessionFile,
  scanSessionFilesIter,
} from "./scanner.ts";
import type { SessionWatch, SessionWatchOptions } from "./watcher.ts";
import { watchSessionFiles } from "./watcher.ts";

export interface SessionIndexOptions {
  store: Store;
  sessionsRoot?: string;
  runDaemonsRoot?: string;
  homeDir?: string;
  tmpDir?: string;
  /**
   * Test seam over the filesystem scan, so a test can count scans (the
   * single-flight contract) and hold one open long enough for a second
   * request to join it, instead of racing real mtimes.
   */
  scan?: (sessionsRoot?: string) => AsyncIterable<RawSessionFile> | Iterable<RawSessionFile>;
}

/** `queryWithWarm`'s answer: first paint now, upgraded rows when they exist. */
export interface SessionQueryResult {
  /**
   * Every row immediately: counts from the durable cache where they exist,
   * `null` where not yet counted (or over the size ceiling, where never).
   */
  sessions: SessionSummary[];
  /**
   * Resolves with the same query re-run once the warm pass has filled in
   * every count first paint reported as unknown, or null when nothing
   * needed warming. It is a fresh query, not a patched-up copy of the first
   * frame: statuses, ordering, and any session files that appeared meanwhile
   * reflect the moment the warm pass finished.
   */
  warmed: Promise<SessionSummary[]> | null;
}

/** One build's outcome: first-paint rows plus the background warm pass they started, if any. */
interface BuildOutcome {
  rows: SessionSummary[];
  warm: Promise<void> | null;
  /**
   * Every session a process holds right now, by id, as this build resolved
   * it: one of ompd's own non-terminal agents, or a verified live client
   * presence, or the single-candidate inference for a bare `omp` whose
   * presence record predates carrying a session id.
   *
   * Separate from `status` because `status` cannot answer this: an archive
   * mark deliberately outranks liveness there, so an archived row a busy
   * agent still holds reports `archived`. Deletion has to know the
   * difference, and reading it off the row would let an archived-then-resumed
   * session be deleted out from under its own writer.
   */
  held: Set<string>;
}

/**
 * Yield scan cadence, in files. Measured here: a scan-shaped pass (readdir
 * + stat + bounded title read) over 1200 files cost 16ms warm, 0.013ms per
 * file; the real-tree figure in scanner.ts's header is ~0.25ms per file
 * cold. Eight files is therefore a 0.1ms slice warm and a ~2ms slice cold
 * -- small enough that a health route or a websocket ping never waits on
 * the scan, at a `setImmediate` cost measured in well under a microsecond.
 */
const SCAN_YIELD_EVERY_FILES = 8;

/**
 * Cache-write batch size, in files. One transaction per batch instead of
 * one per row: an unbatched row was its own implicit transaction -- one WAL
 * commit and one fsync at SQLite's default synchronous=FULL -- and a cold
 * pass over an operator-scale tree (~1900 files observed in the field) paid
 * that once per file, interleaved with the reads, presenting as an
 * I/O-bound wedge at 0% CPU. 128 keeps the in-flight batch tiny and bounds
 * a crash's lost work to files whose counts are a recomputable cache
 * anyway.
 */
const WARM_CACHE_BATCH_ROWS = 128;

/** Hand the event loop to whatever else is waiting: I/O callbacks, timers, sockets. Microtasks do not qualify -- they run before the loop moves on. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

const STATUS_RANK: Record<SessionLiveStatus, number> = {
  "live-ompd": 0,
  "live-tui": 1,
  dormant: 2,
  archived: 3,
};

function cwdScopeFor(cwd: string, homeDir: string, tempDir: string): SessionCwdScope {
  const resolved = resolve(cwd);
  const within = (root: string): boolean => {
    const rel = relative(resolve(root), resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (within(homeDir)) return "home";
  if (within(tempDir)) return "tmp";
  return "abs";
}

function cacheMatches(cached: SessionScanCacheEntry | null, file: RawSessionFile): cached is SessionScanCacheEntry {
  return cached !== null && Math.abs(cached.mtimeMs - file.mtimeMs) < 0.001 && cached.sizeBytes === file.sizeBytes;
}

export class SessionIndex {
  #store: Store;
  #sessionsRoot: string | undefined;
  #runDaemonsRoot: string | undefined;
  #homeDir: string | undefined;
  #tmpDir: string | undefined;
  #scan: NonNullable<SessionIndexOptions["scan"]>;
  /**
   * The in-flight build. Concurrent requests share it rather than each
   * paying their own scan -- one phone's refresh racing another's reconnect
   * replay must not produce two full filesystem walks.
   */
  #buildInFlight: Promise<BuildOutcome> | null = null;
  /**
   * The in-flight background warm pass. One at a time, shared by every
   * build that observed the same cold counts; a pass that would duplicate
   * it returns the existing promise instead.
   */
  #warmInFlight: Promise<void> | null = null;

  constructor(opts: SessionIndexOptions) {
    this.#store = opts.store;
    this.#sessionsRoot = opts.sessionsRoot;
    this.#runDaemonsRoot = opts.runDaemonsRoot;
    this.#homeDir = opts.homeDir;
    this.#tmpDir = opts.tmpDir;
    this.#scan = opts.scan ?? scanSessionFilesIter;
  }

  /**
   * First-paint message count for one file: the durable cache's number when
   * mtime+size still match, and null otherwise -- over the size ceiling
   * forever, under it until the warm pass fills the row in. Never a fresh
   * read here: the request path must not pay for a count, and never a
   * fabricated 0 for an unknown one.
   */
  #firstPaintCountFor(file: RawSessionFile, misses: RawSessionFile[]): number | null {
    if (file.sizeBytes > MESSAGE_COUNT_SIZE_CEILING_BYTES) return null;
    const cached = this.#store.getSessionScanCache(file.id);
    if (cacheMatches(cached, file)) {
      return cached.messageCount;
    }
    misses.push(file);
    return null;
  }

  /**
   * The one shared build entry point. An in-flight build is returned to
   * every concurrent caller; only the first caller's scan runs.
   */
  #buildShared(): Promise<BuildOutcome> {
    if (this.#buildInFlight) return this.#buildInFlight;
    const outcome = this.#buildNow();
    this.#buildInFlight = outcome;
    void outcome
      .catch(() => {})
      .then(() => {
        if (this.#buildInFlight === outcome) this.#buildInFlight = null;
      });
    return outcome;
  }

  /**
   * Build the full catalog fresh from disk, the client presence registry,
   * and ompd's own agent roster. Callers query/group/sort the returned array;
   * nothing about the assembled view itself is cached. Counts are first
   * paint (cache hit or null); the background warm pass for the misses is
   * started here and handed back so callers that can push an upgraded frame
   * can await it.
   */
  async #buildNow(): Promise<BuildOutcome> {
    const files: RawSessionFile[] = [];
    let sinceYield = 0;
    for await (const file of this.#scan(this.#sessionsRoot)) {
      files.push(file);
      if (++sinceYield >= SCAN_YIELD_EVERY_FILES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    const misses: RawSessionFile[] = [];
    const held = new Set<string>();
    const archived = this.#store.listArchivedSessionIds();
    const liveClients = await listLiveClientPresences(this.#runDaemonsRoot ?? runDaemonsRoot());
    const liveClientBySessionId = new Map<string, (typeof liveClients)[number]>();
    for (const client of liveClients) {
      if (client.sessionId) liveClientBySessionId.set(client.sessionId, client);
    }
    // Only non-terminal agents count as "ompd currently holds this session";
    // a stopped or failed agent's session file is still on disk but the
    // process behind it is gone, which `dormant` already describes correctly.
    const liveAgentBySessionId = new Map<string, AgentId>();
    for (const agent of this.#store.listAgents()) {
      if (agent.acpSessionId && !TERMINAL_AGENT_STATES.includes(agent.state)) {
        liveAgentBySessionId.set(agent.acpSessionId, agent.id);
      }
    }

    // A bare `omp` TUI run by an omp build that predates presence carrying
    // `sessionId` leaves its client record without one. Infer its session
    // from the one unclaimed file in its project directory written since it
    // registered; two or more candidates leave every one of them `dormant`
    // rather than guess between them.
    const inferredClientByFileId = new Map<string, (typeof liveClients)[number]>();
    const clientsWithoutSessionId = liveClients.filter(client => !client.sessionId);
    if (clientsWithoutSessionId.length > 0) {
      for (const client of clientsWithoutSessionId) {
        const candidates = files.filter(file => {
          if (liveAgentBySessionId.has(file.id)) return false;
          if (liveClientBySessionId.has(file.id)) return false;
          if (file.cwd === null || resolve(file.cwd) !== resolve(client.projectDir)) return false;
          return file.mtimeMs >= client.registeredAtMs;
        });
        if (candidates.length === 1) {
          const only = candidates[0];
          if (only) inferredClientByFileId.set(only.id, client);
        }
      }
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const cwdScope: SessionCwdScope =
        file.cwd === null ? "unknown" : cwdScopeFor(file.cwd, this.#homeDir ?? homedir(), this.#tmpDir ?? tmpdir());
      const isArchived = archived.has(file.id);
      const agentId = liveAgentBySessionId.get(file.id);
      const liveClient = liveClientBySessionId.get(file.id);
      const inferredClient = inferredClientByFileId.get(file.id);

      const heldByProcess = agentId !== undefined || liveClient !== undefined || inferredClient !== undefined;
      if (heldByProcess) held.add(file.id);

      let status: SessionLiveStatus;
      let pid: number | undefined;
      if (isArchived) {
        // An explicit archive is an operator decision; it outranks a stale
        // client-presence file nobody cleaned up.
        status = "archived";
      } else if (agentId !== undefined) {
        // A live process beats a disk read, and ompd's own supervised agent
        // row -- reconciled independently by the supervisor -- beats a bare
        // client-presence file for the same session.
        status = "live-ompd";
      } else if (liveClient) {
        status = "live-tui";
        pid = liveClient.pid;
      } else if (inferredClient) {
        // No explicit sessionId, but exactly one unclaimed file in this
        // client's project directory was written since it registered.
        status = "live-tui";
        pid = inferredClient.pid;
      } else {
        status = "dormant";
      }

      summaries.push({
        id: file.id,
        cwd: file.cwd,
        cwdScope,
        ...(file.cwd === null ? { cwdDecodeReason: "no_match" as const } : {}),
        flattenedDir: file.flattenedDir,
        title: file.title,
        createdAt: file.createdAt,
        lastActivityAt: new Date(file.mtimeMs).toISOString(),
        messageCount: this.#firstPaintCountFor(file, misses),
        byteSize: file.sizeBytes,
        status,
        archived: isArchived,
        ...(pid !== undefined ? { pid } : {}),
        ...(status === "live-ompd" && agentId !== undefined ? { agentId } : {}),
      });
    }
    const warm = misses.length > 0 ? this.#startWarm(misses) : null;
    return { rows: summaries, warm, held };
  }

  /**
   * Start (or join) the single background warm pass counting what first
   * paint could not. Detached by design: callers that want the upgraded
   * rows hold the returned promise; the daemon keeps serving everything
   * else while it runs.
   */
  #startWarm(files: RawSessionFile[]): Promise<void> {
    if (this.#warmInFlight) return this.#warmInFlight;
    const pass = this.#runWarm(files)
      .catch(() => {
        // Detached work: an unexpected failure here must not become an
        // unhandled rejection. Per-file failures already degrade to a count
        // of 0 inside the counter; reaching this handler means a bug, and
        // the next build's warm pass retries whatever was left cold.
      })
      .finally(() => {
        if (this.#warmInFlight === pass) this.#warmInFlight = null;
      });
    this.#warmInFlight = pass;
    return pass;
  }

  /**
   * Count the cold files and cache the results in batched transactions.
   *
   * Resumability: a row enters the batch only after its file was counted
   * end to end, and the batch commits all-or-nothing, so a partially
   * written chunk can never leave a row claiming a count for content it
   * did not read. A daemon restart mid-pass therefore loses at most the
   * current batch -- every flushed batch is durable -- and the next pass
   * picks up exactly where the cache leaves off, because the per-file
   * re-check below skips every row already written.
   */
  async #runWarm(files: RawSessionFile[]): Promise<void> {
    const batch: Array<{ sessionId: string } & SessionScanCacheEntry> = [];
    for (const file of files) {
      // Re-check the cache per file: a prior pass (or a build racing one)
      // may have counted this exact file between the snapshot and now, and
      // re-reading it would be the duplicated work the single-flight exists
      // to prevent.
      const cached = this.#store.getSessionScanCache(file.id);
      if (cacheMatches(cached, file)) {
        continue;
      }
      const count = await countMessagesAsync(file.path);
      batch.push({ sessionId: file.id, mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes, messageCount: count });
      await yieldToEventLoop(); // Between files, so a corpus of tiny files cannot chain into one long sync run either.
      if (batch.length >= WARM_CACHE_BATCH_ROWS) {
        this.#store.setSessionScanCacheBatch(batch);
        batch.length = 0;
        await yieldToEventLoop(); // After a commit too: the flush is real I/O.
      }
    }
    if (batch.length > 0) this.#store.setSessionScanCacheBatch(batch);
  }

  /** The first-paint rows of one shared build, without a query applied. */
  async build(): Promise<SessionSummary[]> {
    return (await this.#buildShared()).rows;
  }

  /**
   * Query, filter, and sort the catalog, plus the handle a socket caller
   * needs to push one upgraded frame once cold counts land. The HTTP route
   * uses plain `query()`; this is the socket's path because only a socket
   * can answer one request with a second frame.
   */
  async queryWithWarm(q: SessionQuery = {}): Promise<SessionQueryResult> {
    const { rows, warm } = await this.#buildShared();
    return {
      sessions: applyQuery(rows, q),
      warmed: warm === null ? null : warm.then(() => this.query(q)),
    };
  }

  /**
   * One row by session id, or undefined. Sees archived rows too: a caller
   * verifying a session-open request against the index needs the row's true
   * status, and "archived" and "not in the catalog" are different answers.
   *
   * Shares the in-flight build like every other reader, so verifying a claim
   * cannot start a second scan, and reads first-paint rows deliberately: a
   * claim is decided by status, cwd, and pid, none of which the warm pass
   * changes. Waiting for counts here would make opening a session pay for
   * arithmetic it does not consult.
   */
  async get(sessionId: string): Promise<SessionSummary | undefined> {
    const { rows } = await this.#buildShared();
    return rows.find(row => row.id === sessionId);
  }

  /**
   * The session file's own path, or undefined when this machine holds no such
   * session.
   *
   * Deliberately not an index build. Everything a build produces beyond the
   * path -- decoded cwds, verified liveness, message counts, sort order -- is
   * work a transcript read never consults, and on this machine's real tree
   * that work costs 2.9s against the 4 to 6ms this lookup takes. A phone
   * tapping a session and waiting three seconds for its first line of history
   * is the difference, so the walk is targeted and cooperative: one step per
   * group directory, with the event loop handed on between steps.
   *
   * Also deliberately not on `SessionSummary`: that is a wire type, and a
   * client has no business being handed absolute paths on this machine.
   */
  async pathFor(sessionId: string): Promise<string | undefined> {
    const steps = findSessionFileIter(sessionId, this.#sessionsRoot);
    let step = steps.next();
    while (!step.done) {
      await yieldToEventLoop();
      step = steps.next();
    }
    return step.value;
  }

  /** Query, filter, and sort the catalog. Archived sessions are excluded unless `includeArchived` is set. */
  async query(q: SessionQuery = {}): Promise<SessionSummary[]> {
    const { rows } = await this.#buildShared();
    return applyQuery(rows, q);
  }

  /**
   * The same query, grouped by directory. Groups are ordered by their most
   * recent session's activity regardless of the within-group sort key the
   * caller asked for, so the busiest project surfaces first even when
   * sessions inside each group are sorted by, say, size.
   */
  async grouped(q: SessionQuery = {}): Promise<SessionGroup[]> {
    const rows = await this.query(q);
    const groups = new Map<string, SessionGroup>();
    for (const row of rows) {
      const key = row.cwd ?? row.flattenedDir;
      let group = groups.get(key);
      if (!group) {
        group = { key, cwd: row.cwd, sessions: [] };
        groups.set(key, group);
      }
      group.sessions.push(row);
    }
    const out = [...groups.values()];
    out.sort((a, b) => {
      const aLatest = latestActivity(a.sessions);
      const bLatest = latestActivity(b.sessions);
      return bLatest.localeCompare(aLatest);
    });
    return out;
  }

  archive(sessionId: string): void {
    this.#store.archiveSession(sessionId);
  }

  unarchive(sessionId: string): void {
    this.#store.unarchiveSession(sessionId);
  }

  /**
   * Delete sessions for good: the transcript file, the per-session artifact
   * directory OMP writes beside it (same name, `.jsonl` dropped, holding
   * subagent transcripts), and this store's two rows about the session.
   *
   * The one irreversible operation on this catalog, so its refusals are
   * deliberate rather than incidental:
   *
   * - A session a process currently holds is refused. `live-ompd` means one
   *   of this daemon's own agents is writing it, `live-tui` means a terminal
   *   somewhere is. Unlinking a file out from under an open writer does not
   *   stop the writer: on both platforms this runs on it keeps appending to
   *   an inode nothing can reach any more, so the operator loses the rest of
   *   a session that appeared to survive. Stopping or taking over the
   *   session first is the honest order, and the refusal says so.
   * - An id this machine has no file for is refused, not silently reported
   *   as deleted. A caller naming an id that is not here has a stale row or
   *   a typo, and both deserve to be told.
   *
   * Per-id results, in the order asked: one refusal must not abandon the
   * rest of a batch, because the batch exists precisely for the case where
   * hundreds of dead sessions are being cleared and one of them is live.
   *
   * Ordering inside one deletion is the file first, the store second. A
   * removal that fails leaves the store's rows describing a transcript that
   * is still there, which is a consistent state; dropping the rows first and
   * then failing to unlink would leave a real session with its archive mark
   * silently cleared.
   *
   * Liveness comes from one shared build for the whole batch, and from that
   * build's `held` set rather than from a row's `status`: an archive mark
   * outranks liveness in `status`, so an archived session a busy agent still
   * holds reports `archived` there and would otherwise be deletable out from
   * under its own writer. Asking per id would also rescan the tree once per
   * id, which a batch of hundreds cannot afford.
   */
  async delete(sessionIds: readonly string[]): Promise<SessionDeleteResult[]> {
    if (sessionIds.length === 0) return [];
    const { held } = await this.#buildShared();
    const results: SessionDeleteResult[] = [];

    for (const sessionId of sessionIds) {
      if (held.has(sessionId)) {
        results.push({ sessionId, deleted: false, refusal: "live" });
        continue;
      }
      // Resolved through the targeted walk rather than taken from the build:
      // a row is a wire type and carries no path, and this walk only ever
      // returns a file under the configured root whose name matches the
      // session naming scheme, so an id arriving from a client cannot steer
      // the unlink anywhere else.
      const path = await this.pathFor(sessionId);
      if (path === undefined) {
        results.push({ sessionId, deleted: false, refusal: "not_found" });
        continue;
      }
      try {
        await rm(path);
        // `force` on the directory, not on the file: the transcript's absence
        // would mean this deleted nothing, while an artifact directory is
        // optional and most sessions have none.
        await rm(path.slice(0, -".jsonl".length), { recursive: true, force: true });
      } catch {
        results.push({ sessionId, deleted: false, refusal: "failed" });
        continue;
      }
      this.#store.deleteSessionRecords(sessionId);
      results.push({ sessionId, deleted: true });
    }

    return results;
  }

  /**
   * Watch the sessions root for the filesystem events that change this
   * catalog: a session file appearing, changing, or going away, folded into
   * debounced single notifications. The gateway uses this to push refreshed
   * `sessions` frames at sockets that already asked for the index, so a
   * session created by any local `omp` run reaches the phone without a
   * manual refresh.
   *
   * Returns null when the root does not exist yet; see `watchSessionFiles`
   * for why that is a retry rather than a standing error. The root resolved
   * here is the same one the scan walks, so a watcher can never report on a
   * tree the catalog does not read.
   */
  watch(onChange: () => void, opts?: SessionWatchOptions): SessionWatch | null {
    return watchSessionFiles(this.#sessionsRoot ?? getSessionsDir(), onChange, opts);
  }
}

function applyQuery(rows: SessionSummary[], q: SessionQuery): SessionSummary[] {
  let out = rows;
  if (!q.includeArchived) out = out.filter(r => !r.archived);
  if (q.status && q.status.length > 0) {
    const wanted = q.status;
    out = out.filter(r => wanted.includes(r.status));
  }
  if (q.cwd !== undefined) {
    const wantedCwd = q.cwd;
    out = out.filter(r => r.cwd === wantedCwd || r.flattenedDir === wantedCwd);
  }
  return sortSessions(out, q.sort ?? "lastActivity", q.sortDir ?? "desc");
}

function latestActivity(sessions: SessionSummary[]): string {
  let latest = "";
  for (const s of sessions) {
    if (s.lastActivityAt > latest) latest = s.lastActivityAt;
  }
  return latest;
}

function sortSessions(rows: SessionSummary[], key: SessionSortKey, dir: SessionSortDir): SessionSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (key) {
      case "status":
        return sign * (STATUS_RANK[a.status] - STATUS_RANK[b.status]);
      case "age":
        return sign * a.createdAt.localeCompare(b.createdAt);
      case "lastActivity":
        return sign * a.lastActivityAt.localeCompare(b.lastActivityAt);
      case "messageCount":
        // Null (uncounted, oversized) sorts as lowest so an unknown count
        // never silently outranks a real one regardless of direction.
        return sign * ((a.messageCount ?? -1) - (b.messageCount ?? -1));
      case "size":
        return sign * (a.byteSize - b.byteSize);
      default: {
        const exhaustive: never = key;
        throw new Error(`unhandled sort key ${String(exhaustive)}`);
      }
    }
  });
}
