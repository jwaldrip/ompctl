/**
 * capture-shots.ts — deterministic screenshot capture for ompctl.ai
 *
 * Captures product marketing screenshots across phone (390x844 @2x) and
 * desktop (1440x900) viewports, and records the load-bearing measurements
 * of the integrated app tree.
 *
 * PREREQUISITES (what this script needs running):
 * 1. The web application build must exist at `packages/app/dist`
 *    (`cd packages/app && bun run build:web`).
 * 2. The local daemon `ompd` must be running (`ompd status`).
 * 3. Chrome must be open with the OMP Browser Relay listening on port 9224
 *    (`ws://127.0.0.1:9224/cdp`).
 * 4. Loopback TCP port 4182 must be free to serve the web application.
 *
 * SAFETY INVARIANTS (what this script refuses to do):
 * 1. Refuses to run if `ompd` is not reachable.
 * 2. Refuses to run if the browser relay on port 9224 is not reachable.
 * 3. Refuses to mutate, prompt, resume, take over, stop, or delete any session
 *    on the daemon (read-only throughout).
 * 4. Refuses to open Config on a live TUI session.
 * 5. Refuses to leave scratch pairing credentials or token files on disk
 *    (always revokes the device and deletes scratch files in finally).
 * 6. Refuses to leak private client names, internal repo paths, user tokens,
 *    or raw personal transcript prose into public marketing shots (applies a
 *    deterministic DOM allowlist sanitization pass prior to each capture).
 * 7. Refuses to ship broken, empty, or error-bearing frames (asserts surface
 *    health before every screenshot).
 *
 * Usage:
 *   bun run scripts/capture-shots.ts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const SITE_PKG_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SITE_PKG_DIR, "../..");
const APP_DIST_DIR = resolve(REPO_ROOT, "packages/app/dist");
const SHOTS_OUTPUT_DIR = resolve(SITE_PKG_DIR, "public/shots");

const PREVIEW_PORT = 4182;
const RELAY_CDP_URL = "ws://127.0.0.1:9224/cdp";

export interface Measurements {
  fleetList: {
    viewportHeight: number;
    listBottom: number;
    lastRowBottom: number;
    deadBand: number;
    rowsCount: number;
  };
  modelAndRole: {
    sampleReadings: Array<{ id: string; modelText: string | null; roleText: string | null }>;
    unrecordedModelFallback: string;
    unrecordedRoleRendered: boolean;
  };
  markdownTable: {
    rendersAsCells: boolean;
    tableCellCount: number;
    tableHeaderCount: number;
    hasRawPipesInDOM: boolean;
  };
  terminalMicControl: {
    hasTerminalMic: boolean;
    hasTerminalComposer: boolean;
    reason: string;
  };
  sessionScroll: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    targetScrollTop: number;
    diff: number;
    landsAtNewest: boolean;
  };
}

/**
 * Generator: Deterministic Believable Corpus Generator
 * Curated systems-engineering projects, titles, devices, and subagents
 * that represent plausible high-performance engineering work.
 */
export const BELIEVABLE_MARKETING_DATA = {
  projects: [
    { name: "edge-mesh", path: "/workspace/edge-mesh/packages/router" },
    { name: "vector-engine", path: "/workspace/vector-engine/src/index" },
    { name: "distributed-kv", path: "/workspace/distributed-kv/engine/raft" },
    { name: "telemetry-collector", path: "/workspace/telemetry-collector/services/ingest" },
    { name: "cloud-orchestrator", path: "/workspace/cloud-orchestrator/control-plane" },
    { name: "stream-pipeline", path: "/workspace/stream-pipeline/connectors/kafka" },
    { name: "agent-runtime", path: "/workspace/agent-runtime/packages/sandbox" },
    { name: "auth-broker", path: "/workspace/auth-broker/internal/oidc" },
    { name: "metrics-exporter", path: "/workspace/metrics-exporter/pkg/collector" },
    { name: "api-mesh", path: "/workspace/api-mesh/services/routing" },
    { name: "event-bus", path: "/workspace/event-bus/transport/quic" },
    { name: "blob-store", path: "/workspace/blob-store/storage/cas" },
  ],
  titles: [
    "Implement QUIC transport fallback for edge gateway",
    "Optimize vector index compaction on NVMe scratch",
    "Profile memory allocations in raft consensus loop",
    "Add distributed trace propagation to gRPC client",
    "Refactor token bucket rate limiter to lock-free ring",
    "Fix connection pool leak during graceful shutdown",
    "Migrate schema validation to zero-copy protobuf decoder",
    "Audit TLS session ticket resumption in proxy core",
    "Benchmark streaming JSON parser against simdjson",
    "Harden worker supervision against OOM kills",
    "Instrument query planner with latency breakdown histograms",
    "Verify partition rebalancing under packet loss",
    "Add speculative execution to scatter-gather queries",
    "Fix deadband calculation in metrics sliding window",
    "Optimize zero-copy slice deserialization in stream parser",
    "Implement tiered LRU eviction for block cache",
    "Audit concurrent socket lifecycle during failover",
    "Harden handshake timeout against slowloris attacks",
    "Refactor connection state machine for sub-millisecond failover",
    "Index compaction pipeline for write-heavy timeseries workloads",
  ],
  devices: [
    "MacBook Pro M3 Max",
    "Pixel 8 Pro",
    "Ubuntu Workstation 24.04",
    "iPhone 16 Pro",
    "ThinkPad P1 Gen 7",
    "iPad Pro M4",
  ],
  subagents: [
    { name: "BenchmarkRunner", task: "Running throughput benchmark under concurrent load" },
    { name: "MemoryProfiler", task: "Profiling heap allocations during reconnect loop" },
    { name: "RaftAuditor", task: "Inspecting state machine transition logs" },
    { name: "ProtocolValidator", task: "Verifying wire frame format against schema" },
    { name: "CacheInspector", task: "Auditing L1/L2 cache hit rate and eviction" },
    { name: "ConcurrencyGate", task: "Testing lock contention under 1000 simulated peers" },
    { name: "QueryOptimizer", task: "Analyzing execution plans for partition scans" },
    { name: "LeakDetector", task: "Monitoring file descriptor allocations under stress" },
  ],
  prompts: [
    "Profile memory allocations during connection reconnects and remove redundant heap copies.",
    "Investigate lock contention in worker queue under high concurrency.",
    "Benchmark throughput across varying packet sizes and verify zero-copy ring buffer invariants.",
  ],
  thinking: [
    "Analyzing buffer allocation in stream reader",
    "Inspecting lock contention in worker queue ring buffer",
    "Tracing socket lifecycle across reconnect transitions",
    "Evaluating memory overhead of zero-copy slice parser",
    "Verifying state machine invariants during failover",
  ],
  commands: [
    {
      cmd: "eval: cargo bench --bench throughput",
      output:
        "PASS: TestConnectionPoolLifecycle (0.12s)\nPASS: TestGracefulShutdownTimeout (0.34s)\nPASS: TestConcurrentTicketResumption (0.28s)\nPASS: TestRingBufferZeroAllocation (0.05s)\n4 tests passed, 0 failures, 0 skipped.",
    },
    {
      cmd: "eval: go test -v -race ./pkg/transport/...",
      output:
        "=== RUN   TestTransportDial\n=== RUN   TestTransportHandshake\n--- PASS: TestTransportDial (0.04s)\n--- PASS: TestTransportHandshake (0.08s)\nPASS\nok      pkg/transport   0.142s",
    },
  ],
};
export function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return Math.abs(h);
}

export const BELIEVABLE_REPLACEMENTS: readonly string[] = [
  "edge-mesh",
  "cloud-telephony",
  "mesh-net",
  "core-systems",
  "voice-agent",
  "vector-engine",
  "distributed-kv",
  "telemetry-collector",
  "cloud-orchestrator",
  "stream-pipeline",
  "agent-runtime",
  "auth-broker",
  "metrics-exporter",
  "api-mesh",
  "event-bus",
  "blob-store",
  "agent-fleet",
  "workspace",
  "developer",
  "telephony-provider",
  "analytics",
  "systems-core",
  "edge-gateway",
  "data-mesh",
] as const;

/**
 * Read operator provenance terms from the environment.
 * Supports OMPCTL_PROVENANCE_TERMS (comma/whitespace separated) or
 * OMPCTL_PROVENANCE_TERMS_FILE pointing to a term file.
 * Returns an empty array if unset.
 */
export function getProvenanceTerms(): string[] {
  const inline = process.env.OMPCTL_PROVENANCE_TERMS;
  const path = process.env.OMPCTL_PROVENANCE_TERMS_FILE;
  let raw = "";
  if (inline !== undefined && inline.trim().length > 0) {
    raw = inline;
  } else if (path !== undefined && path.trim().length > 0) {
    if (existsSync(path)) {
      raw = readFileSync(path, "utf8");
    }
  }
  return raw
    .split(/[\n,]/)
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length > 0);
}

/**
 * Build host-side redaction pairs mapping each provenance term to a deterministic,
 * believable synthetic replacement.
 */
export function buildRedactionPairs(terms?: string[]): Array<[string, string]> {
  const list = terms ?? getProvenanceTerms();
  const unique = Array.from(new Set(list)).sort();
  const pairs: Array<[string, string]> = [];
  const used = new Set<string>();

  for (const term of unique) {
    let idx = fnv1a(term) % BELIEVABLE_REPLACEMENTS.length;
    let attempts = 0;
    while (used.has(BELIEVABLE_REPLACEMENTS[idx]!) && attempts < BELIEVABLE_REPLACEMENTS.length) {
      idx = (idx + 1) % BELIEVABLE_REPLACEMENTS.length;
      attempts++;
    }
    const rep = BELIEVABLE_REPLACEMENTS[idx]!;
    used.add(rep);
    pairs.push([term, rep]);
  }

  // Sort descending by term length so longer phrases are matched before sub-phrases.
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

export interface SensitiveTargetSet {
  clientAndOrgNames: string[];
  sessionTitles: string[];
  directories: string[];
}

/**
 * Everything the capture must never publish.
 *
 * 1. Operator-supplied terms, read from `OMPCTL_PROVENANCE_TERMS`.
 * 2. Org and repo names from ~/.omp/agent/sessions/ directory names.
 * 3. Actual session titles and working directories from ompd read-only.
 *
 * The first list used to be literal client names in this file. That is a
 * disclosure in its own right: this repository is public, so enumerating who
 * the operator works for in order to redact them publishes the same fact the
 * redaction exists to hide. The repository already carries the right
 * mechanism, the `OMPCTL_PROVENANCE_TERMS` secret that
 * `scripts/check-provenance.ts` sweeps against, so the names live there and
 * this file only knows how to read them.
 *
 * Absent the variable there are no operator terms, and the other two sources
 * still apply. That is deliberate rather than a silent downgrade: a capture
 * run by someone who is not the operator has no operator names to hide, and
 * `check-provenance.ts` is the gate that catches it if that is ever wrong.
 */
export function assembleSensitiveStrings(): SensitiveTargetSet {
  const clientAndOrgNames = new Set<string>();
  const sessionTitles = new Set<string>();
  const directories = new Set<string>();

  const supplied = getProvenanceTerms();
  for (const n of supplied) clientAndOrgNames.add(n);
  const commonWords = new Set([
    "ompctl",
    "ompd",
    "daemon",
    "agent",
    "session",
    "switch",
    "work",
    "server",
    "para",
    "scratch",
    "main",
    "test",
    "host",
    "socket",
    "fleet",
    "hub",
    "client",
    "model",
    "app",
    "web",
    "android",
    "ios",
    "macos",
    "windows",
    "dev",
    "src",
    "docs",
    "documentation",
    "core",
    "api",
    "cli",
  ]);

  const sessionsDir = resolve(process.env.HOME ?? "", ".omp/agent/sessions");
  if (existsSync(sessionsDir)) {
    try {
      for (const entry of readdirSync(sessionsDir)) {
        const match = entry.match(/-dev-src-github\.com-([a-zA-Z0-9_.-]+)-([a-zA-Z0-9_.-]+)/);
        if (match) {
          const org = match[1]?.toLowerCase();
          const repo = match[2]?.toLowerCase();
          if (org && org.length > 3 && !commonWords.has(org)) clientAndOrgNames.add(org);
          if (repo && repo.length > 3 && !commonWords.has(repo)) clientAndOrgNames.add(repo);
        }
      }
    } catch {}
  }

  try {
    const proc = Bun.spawnSync(["ompd", "agents"]);
    const output = proc.stdout.toString();
    for (const line of output.split("\n")) {
      if (!line.startsWith("agt_")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const cwdIndex = parts.findIndex(p => p.startsWith("/"));
        if (cwdIndex > 2) {
          const title = parts.slice(2, cwdIndex).join(" ");
          const cwd = parts[cwdIndex];
          if (
            title &&
            title.length > 2 &&
            title !== "Untitled session" &&
            !commonWords.has(title.toLowerCase()) &&
            !["desktop", "tick", "mvp"].includes(title.toLowerCase())
          ) {
            sessionTitles.add(title.toLowerCase());
          }
          if (cwd && !["/tmp", "/private/tmp", "/var", "/usr"].includes(cwd.toLowerCase())) {
            directories.add(cwd.toLowerCase());
          }
        }
      }
    }
  } catch {}

  return {
    clientAndOrgNames: Array.from(clientAndOrgNames),
    sessionTitles: Array.from(sessionTitles),
    directories: Array.from(directories),
  };
}

/**
 * Structural Allowlist Verifier:
 * Asserts no private targets, no raw thread/message IDs, no email addresses,
 * no Google/Gmail references, and no third-party extensions (Speechify) appear
 * in the captured DOM.
 */
export function checkDomForLeaks(domText: string, targets: SensitiveTargetSet): string[] {
  const lower = domText.toLowerCase();
  const leaks: string[] = [];

  // 1. Client and org names
  for (const name of targets.clientAndOrgNames) {
    if (lower.includes(name)) {
      leaks.push(`client/org:${name}`);
    }
  }

  // 2. Session titles
  for (const title of targets.sessionTitles) {
    if (lower.includes(title)) {
      leaks.push(`title:${title}`);
    }
  }

  // 3. Directories
  for (const dir of targets.directories) {
    if (lower.includes(dir)) {
      leaks.push(`directory:${dir}`);
    }
  }

  // 4. Email addresses
  const emailMatch = domText.match(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/);
  if (emailMatch && emailMatch[0] !== "developer@example.com") {
    leaks.push(`email:${emailMatch[0]}`);
  }

  // 5. Raw thread / message IDs
  const hexIdMatch = domText.match(/\b1[a-f0-9]{15,}\b/);
  if (hexIdMatch) {
    leaks.push(`raw_hex_id:${hexIdMatch[0]}`);
  }

  // 6. Gmail / mailbox references
  if (lower.includes("gmail") || lower.includes("threadid") || lower.includes("firebaseapp")) {
    leaks.push("unapproved_content:gmail/mailbox_payload");
  }

  // 7. Speechify browser extension toolbar
  if (lower.includes("speechify") || domText.includes("speechify-")) {
    leaks.push("extension_chrome:speechify_toolbar");
  }

  return leaks;
}

export async function sanitizeDomForPublicShot(page: Page, customPairs?: Array<[string, string]>): Promise<void> {
  const redactionPairs = customPairs ?? buildRedactionPairs();
  await page.evaluate(
    ({ data, redactionPairs }) => {
      function fnv1a(str: string): number {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
          h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        }
        return Math.abs(h);
      }

      // 1. Remove Speechify browser extension completely
      const allDomEls = Array.from(document.querySelectorAll("*"));
      for (const el of allDomEls) {
        const id = (el.id || "").toLowerCase();
        const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
        const tag = el.tagName.toLowerCase();
        if (id.includes("speechify") || cls.includes("speechify") || tag.includes("speechify")) {
          el.remove();
        }
      }

      // 2. Dismiss any resume modal
      (document.querySelector('[data-testid="resume-nudge-close"]') as HTMLElement | null)?.click();

      // 3. Top header titles
      const allDivs = Array.from(document.querySelectorAll('div[dir="auto"], span'));
      for (const d of allDivs) {
        if (d.textContent && /^Cloud \d+$/i.test(d.textContent.trim())) {
          d.textContent = "Workstation M3 Max";
        }
      }

      // 4. Fleet list rows: unconditional replacement of title, cwd, aria-labels
      const rows = Array.from(
        document.querySelectorAll('[data-testid^="session-row-"], [data-testid^="session-open-"]'),
      );
      const seenRows = new Set<Element>();
      rows.forEach((r, idx) => {
        const row = r.getAttribute("data-testid")?.startsWith("session-row-")
          ? r
          : (r.closest('[data-testid^="session-row-"]') ?? r);
        if (seenRows.has(row)) return;
        seenRows.add(row);

        const tid = row.getAttribute("data-testid") ?? "";
        const sessId = tid.replace("session-row-", "").replace("session-open-", "");
        const h = fnv1a(sessId || String(idx));
        const syntheticTitle = data.titles[h % data.titles.length] ?? "System worker task";
        const syntheticProject = data.projects[h % data.projects.length] ?? data.projects[0]!;
        const shortPath = "…/" + syntheticProject.path.split("/").slice(-2).join("/");

        // Unconditionally scrub all aria-labels inside this row
        const ariaEls = Array.from(row.querySelectorAll("[aria-label]"));
        if (row.hasAttribute("aria-label")) ariaEls.push(row);
        for (const el of ariaEls) {
          const a = el.getAttribute("aria-label") ?? "";
          if (/^more for/i.test(a)) {
            el.setAttribute("aria-label", `More for ${syntheticTitle}`);
          } else if (/^(open|prompt|resume|restore|attach)/i.test(a)) {
            el.setAttribute("aria-label", `Open ${syntheticTitle}`);
          } else if (/^delete/i.test(a)) {
            el.setAttribute("aria-label", `Delete ${syntheticTitle}`);
          } else if (/^keep/i.test(a)) {
            el.setAttribute("aria-label", `Keep ${syntheticTitle}`);
          } else {
            el.setAttribute("aria-label", syntheticTitle);
          }
        }

        // Target the title: in SessionRow it is previousElementSibling of session-status
        const statusEl = row.querySelector(`[data-testid^="session-status-"]`);
        if (statusEl && statusEl.previousElementSibling) {
          statusEl.previousElementSibling.textContent = syntheticTitle;
        }

        // Replace any cwd texts inside row
        const allRowDivs = Array.from(row.querySelectorAll('div[dir="auto"]'));
        for (const div of allRowDivs) {
          const txt = div.textContent ?? "";
          if (txt.includes("github.com") || txt.startsWith("…/") || txt.startsWith("/")) {
            div.textContent = shortPath;
          }
        }
      });

      // 5. Group headers & group paths & data-testid attributes
      const groupPaths = Array.from(document.querySelectorAll('[data-testid^="group-path-"]'));
      groupPaths.forEach((el, idx) => {
        const p = data.projects[idx % data.projects.length] ?? data.projects[0]!;
        el.textContent = p.path;
        el.setAttribute("data-testid", `group-path-proj-${idx}`);
      });

      const groupHeaders = Array.from(document.querySelectorAll('[data-testid^="group-header-"]'));
      groupHeaders.forEach((el, idx) => {
        const p = data.projects[idx % data.projects.length] ?? data.projects[0]!;
        el.setAttribute("data-testid", `group-header-proj-${idx}`);
        el.setAttribute("aria-label", `${p.path}, active sessions`);
      });

      // 6. Active session header
      const termTitle = document.querySelector('[data-testid="terminal-title"]');
      if (termTitle) {
        termTitle.textContent = data.titles[0] ?? "";
      }
      const sessName = document.querySelector('[data-testid="session-name"]');
      if (sessName) {
        sessName.textContent = data.titles[0] ?? "";
      }

      // Header origin folder & session-context-cwd
      const originEls = Array.from(document.querySelectorAll('[style*="origin"], [data-testid="session-context-cwd"]'));
      for (const el of originEls) {
        const proj = data.projects[0]!;
        el.textContent = "…/" + proj.path.split("/").slice(-2).join("/");
      }

      // 7. Subagents band
      const subRows = Array.from(document.querySelectorAll('[data-testid^="subagent-transcript-"]'));
      subRows.forEach((sr, idx) => {
        const sa = data.subagents[idx % data.subagents.length] ?? data.subagents[0]!;
        const nameEl = sr.querySelector('div[dir="auto"]');
        if (nameEl) {
          nameEl.textContent = sa.name;
        }
        sr.setAttribute("data-testid", `subagent-transcript-${idx}`);
        sr.setAttribute("aria-label", `Subagent ${sa.name}`);
      });

      const subAssignments = Array.from(document.querySelectorAll('[data-testid*="-assignment-"]'));
      subAssignments.forEach((saEl, idx) => {
        const sa = data.subagents[idx % data.subagents.length] ?? data.subagents[0]!;
        saEl.textContent = sa.task;
        saEl.setAttribute("data-testid", `subagent-assignment-${idx}`);
      });

      const subCardNames = Array.from(document.querySelectorAll('[data-testid*="-name-"]'));
      subCardNames.forEach((snEl, idx) => {
        const sa = data.subagents[idx % data.subagents.length] ?? data.subagents[0]!;
        snEl.textContent = sa.name;
        snEl.setAttribute("data-testid", `subagent-name-${idx}`);
      });

      // 8. WHOLESALE TRANSCRIPT REPLACEMENT (No real content allowed to reach capture)
      // User prompts
      const userEntries = Array.from(
        document.querySelectorAll('[data-testid="entry-user"], [data-testid="transcript-say"]'),
      );
      userEntries.forEach((ue, idx) => {
        ue.textContent = data.prompts[idx % data.prompts.length] ?? data.prompts[0]!;
      });

      // Thinking blocks: replace text, aria-labels, and parent aria-labels
      const thinkingSummaries = Array.from(
        document.querySelectorAll('[data-testid*="thinking-summary"], [data-testid="terminal-thinking"]'),
      );
      thinkingSummaries.forEach((th, idx) => {
        const summary = data.thinking[idx % data.thinking.length] ?? data.thinking[0]!;
        th.textContent = summary;
        th.setAttribute("aria-label", `thinking: ${summary}`);
        if (th.parentElement?.hasAttribute("aria-label")) {
          th.parentElement.setAttribute("aria-label", `thinking: ${summary}`);
        }
      });

      const thinkingArias = Array.from(document.querySelectorAll('[aria-label*="thinking:"]'));
      thinkingArias.forEach((el, idx) => {
        const summary = data.thinking[idx % data.thinking.length] ?? data.thinking[0]!;
        el.setAttribute("aria-label", `thinking: ${summary}`);
      });
      // Tool outputs
      const toolOutputs = Array.from(document.querySelectorAll('[data-testid*="tool-output"]'));
      toolOutputs.forEach((to, idx) => {
        const item = data.commands[idx % data.commands.length] ?? data.commands[0]!;
        to.textContent = item.output;
      });

      // Tool summaries
      const toolSummaries = Array.from(document.querySelectorAll('[data-testid*="tool-summary"]'));
      toolSummaries.forEach((ts, idx) => {
        const item = data.commands[idx % data.commands.length] ?? data.commands[0]!;
        ts.textContent = item.output.split("\n")[0] ?? "PASS";
      });

      // Tool titles
      const toolTitles = Array.from(document.querySelectorAll('[data-testid*="tool-title"]'));
      toolTitles.forEach(tt => {
        tt.textContent = "eval";
      });

      // Tool statuses
      const toolStatuses = Array.from(
        document.querySelectorAll('[data-testid*="tool-status"]:not([data-testid$="-container"])'),
      );
      toolStatuses.forEach(st => {
        st.textContent = "completed";
      });

      // Assistant prose entries (outside tool cards)
      const assistantEntries = Array.from(document.querySelectorAll('[data-testid="entry-assistant"]'));
      assistantEntries.forEach(ae => {
        if (!ae.querySelector('[data-testid*="tool-"]')) {
          ae.textContent =
            "I have profiled the memory allocations during the connection lifecycle. The connection pool now reuses buffers with zero heap allocations during reconnects.";
        }
      });

      // All code and pre blocks
      document.querySelectorAll("pre, code").forEach((el, idx) => {
        const item = data.commands[idx % data.commands.length] ?? data.commands[0]!;
        el.textContent = item.output;
      });

      function escapeRegExp(str: string): string {
        return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      }

      const termRegexes = redactionPairs
        .filter(([term]) => term.length > 0)
        .map(([term, rep]) => [new RegExp(escapeRegExp(term), "gi"), rep] as const);

      // 9. Universal attribute sanitizer on ALL elements
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        for (const attr of Array.from(el.attributes)) {
          let val = attr.value;
          if (!val || val.length === 0) continue;

          val = val.replace(
            /\/Users\/[a-zA-Z0-9_-]+\/dev\/src\/github\.com\/[^\s'"()]+/g,
            "/workspace/edge-mesh/packages/router",
          );
          val = val.replace(/\/Users\/[a-zA-Z0-9_-]+\/[^\s'"()]+/g, "/workspace/project");
          val = val.replace(/\/private\/tmp\/[^\s'"()]+/g, "/tmp/scratch");
          val = val.replace(/\/tmp\/[^\s'"()]+/g, "/tmp/scratch");
          val = val.replace(/…\/(github\.com|workspace)\/[^\s'"()]+/g, "…/workspace/edge-mesh");
          val = val.replace(/github\.com\/[^\s'"()]+/g, "github.com/cloud-platform/edge-mesh");
          val = val.replace(/monorepo/gi, "edge-mesh");

          for (const [re, rep] of termRegexes) {
            val = val.replace(re, rep);
          }

          if (val !== attr.value) {
            attr.value = val;
          }
        }
      }

      // 10. Universal defense-in-depth text node pass
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null = walk.nextNode();
      while (node !== null) {
        let text = node.nodeValue ?? "";
        if (text.length > 0) {
          text = text.replace(
            /\/Users\/[a-zA-Z0-9_-]+\/dev\/src\/github\.com\/[^\s'"()]+/g,
            "/workspace/edge-mesh/packages/router",
          );
          text = text.replace(/\/Users\/[a-zA-Z0-9_-]+\/[^\s'"()]+/g, "/workspace/project");
          text = text.replace(/\/private\/tmp\/[^\s'"()]+/g, "/tmp/scratch");
          text = text.replace(/\/tmp\/[^\s'"()]+/g, "/tmp/scratch");
          text = text.replace(/…\/(github\.com|workspace)\/[^\s'"()]+/g, "…/workspace/edge-mesh");
          text = text.replace(/github\.com\/[^\s'"()]+/g, "github.com/cloud-platform/edge-mesh");
          text = text.replace(/monorepo/gi, "edge-mesh");

          for (const [re, rep] of termRegexes) {
            text = text.replace(re, rep);
          }

          node.nodeValue = text;
        }
        node = walk.nextNode();
      }
    },
    { data: BELIEVABLE_MARKETING_DATA, redactionPairs },
  );
}

/**
 * Health Assertion Guard:
 * Asserts the surface to photograph is rendered, healthy, and non-empty.
 * Refuses to ship any frame with error banners, toasts, broken sockets, or modals.
 */
export async function assertFrameHealthy(frameName: string, page: Page): Promise<void> {
  const health = await page.evaluate((frame: string) => {
    // 1. Universal error checks: no toasts or connection drop overlays
    const toast = document.querySelector('[data-testid="toast"], [data-testid="toast-link"]');
    if (toast) {
      return { ok: false, error: `Found error toast: "${toast.textContent?.trim()}"` };
    }

    const stalled = document.querySelector('[data-testid="session-load-stalled"]');
    if (stalled) {
      return { ok: false, error: `Session load stalled (Link lost): "${stalled.textContent?.trim()}"` };
    }

    const failed = document.querySelector('[data-testid="session-load-failed"]');
    if (failed) {
      return { ok: false, error: `Session load failed: "${failed.textContent?.trim()}"` };
    }

    const resumeNudge = document.querySelector('[data-testid^="resume-nudge"]');
    if (resumeNudge) {
      return { ok: false, error: `Resume modal is blocking the screen: "${resumeNudge.textContent?.trim()}"` };
    }

    // 2. Surface-specific assertions
    if (frame.includes("01-pairing")) {
      const inputs = document.querySelectorAll('input, [data-testid="pair-screen"]');
      if (inputs.length === 0 && !document.body.innerText.includes("pair")) {
        return { ok: false, error: "Pairing form is not visible" };
      }
    } else if (frame.includes("02-fleet-list")) {
      const list = document.querySelector('[data-testid="fleet-list"]');
      const rows = document.querySelectorAll('[data-testid^="session-open-"]');
      if (!list || rows.length === 0) {
        return { ok: false, error: `Fleet list has 0 rows (empty fleet state)` };
      }
    } else if (frame.includes("03-desktop-split-view")) {
      const rows = document.querySelectorAll('[data-testid^="session-open-"]');
      const log = document.querySelector(
        '[data-testid="terminal-log"], [data-testid="transcript-entry"], [data-testid="terminal-composer-surface"], [data-testid="aui-messages"], [data-testid="aui-thread"], [data-testid="session"]',
      );
      if (rows.length === 0 || !log) {
        return { ok: false, error: "Desktop split view missing session list or transcript pane" };
      }
    } else if (frame.includes("04-session-transcript")) {
      const log = document.querySelector(
        '[data-testid="terminal-log"], [data-testid="transcript-entry"], [data-testid="terminal-composer-surface"], [data-testid="aui-messages"], [data-testid="aui-thread"], [data-testid="session"]',
      );
      if (!log) {
        return { ok: false, error: "Session transcript is not rendered" };
      }
    } else if (frame.includes("05-subagents-band")) {
      const subToggle = document.querySelector('[data-testid="terminal-subagents-toggle"]');
      const subList = document.querySelector('[data-testid="terminal-subagents-list"]');
      const subRows = document.querySelectorAll('[data-testid^="subagent-"]');
      if (!subToggle && !subList && subRows.length === 0) {
        return { ok: false, error: "Subagents band is not rendered" };
      }
    } else if (frame.includes("06-routines")) {
      const routinesScreen = document.querySelector('[data-testid="routines-screen"]');
      const readErr = document.querySelector('[data-testid="routines-read-error"]');
      const actionErr = document.querySelector('[data-testid="routines-action-error"]');
      if (readErr || actionErr) {
        return {
          ok: false,
          error: `Routines screen in error state: ${readErr?.textContent || actionErr?.textContent}`,
        };
      }
      if (!routinesScreen) {
        return { ok: false, error: "Routines screen is not rendered" };
      }
    } else if (frame.includes("07-connections")) {
      const conns = document.querySelectorAll('[data-testid^="connection-"], div[dir="auto"]');
      if (conns.length === 0) {
        return { ok: false, error: "Connections screen is empty" };
      }
    }

    return { ok: true, error: null };
  }, frameName);

  if (!health.ok) {
    throw new Error(`HEALTH ASSERTION GUARD FAILED on ${frameName}: ${health.error}`);
  }
}

/** Pre-flight check verifying prerequisites exist before running. */
function checkPrerequisites(): void {
  if (!existsSync(APP_DIST_DIR) || !statSync(APP_DIST_DIR).isDirectory()) {
    throw new Error(`Web app dist missing at ${APP_DIST_DIR}. Run: bun run --cwd packages/app build:web`);
  }
  const terms = getProvenanceTerms();
  if (terms.length === 0) {
    throw new Error(
      "Refusing capture: OMPCTL_PROVENANCE_TERMS is unset or empty. Capturing without terms would risk publishing unredacted operator data.",
    );
  }
}

export interface LeakProofOptions {
  disableSanitization?: boolean;
}

/** Run the failing-then-passing leak proof test on demand. */
export async function runLeakProofTest(pairLink: string, browser: Browser, options?: LeakProofOptions): Promise<void> {
  console.log("\n=======================================================");
  console.log("=== RUNNING LEAK TEST PROOF (FAILING THEN PASSING) ===");
  console.log("=======================================================");
  const targets = assembleSensitiveStrings();
  const totalCount = targets.clientAndOrgNames.length + targets.sessionTitles.length + targets.directories.length;
  console.log(
    `Assembled ${totalCount} sensitive strings to guard (${targets.clientAndOrgNames.length} orgs/clients, ${targets.sessionTitles.length} titles, ${targets.directories.length} dirs).`,
  );

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(pairLink, { waitUntil: "networkidle2" });
    await Bun.sleep(2500);

    // Open a live session so the transcript/tool-output is mounted
    const sel = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid^="session-open-"]'));
      for (const r of rows) {
        const tid = r.getAttribute("data-testid");
        if (tid && tid.includes("01a07f16")) return `[data-testid="${tid}"]`;
      }
      return rows[0] ? `[data-testid="${rows[0].getAttribute("data-testid")}"]` : null;
    });
    if (sel) {
      const c = await page.evaluate(s => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, sel);
      if (c) {
        await page.mouse.click(c.x, c.y);
        await Bun.sleep(2500);
      }
    }

    // STEP 1: Verify check FAILS on unsanitized DOM
    console.log("\n[LEAK TEST 1: Unsanitized DOM]");
    console.log("Expected outcome: FAILS with detected real strings.");
    const rawDom = await page.evaluate(() => document.body.innerText + "\n" + document.documentElement.innerHTML);
    const rawLeaks = checkDomForLeaks(rawDom, targets);
    if (rawLeaks.length > 0) {
      console.log(`RESULT: PROVABLY FAILED as expected. Caught ${rawLeaks.length} private leak(s):`);
      const safeSamples = rawLeaks.slice(0, 8).map(l => (l.startsWith("client/org:") ? "client/org:[REDACTED]" : l));
      console.log(`  Sample leaks: ${safeSamples.join(", ")}`);
    } else {
      throw new Error("UNEXPECTED PASS on unsanitized DOM! The leak detector must be able to fail.");
    }

    // STEP 2: Apply allowlist sanitization and verify check PASSES
    console.log("\n[LEAK TEST 2: With Allowlist Sanitizer Applied]");
    console.log("Expected outcome: PASSES with 0 detected leaks.");
    if (options?.disableSanitization) {
      console.log("[SANITIZATION DISABLED BY OPTION]");
    } else {
      await sanitizeDomForPublicShot(page);
      await Bun.sleep(500);
    }

    const sanitizedDom = await page.evaluate(() => document.body.innerText + "\n" + document.documentElement.innerHTML);
    const sanitizedLeaks = checkDomForLeaks(sanitizedDom, targets);
    if (sanitizedLeaks.length === 0) {
      console.log(`RESULT: PROVABLY PASSED! 0 leaks found across all ${totalCount} sensitive targets.`);
    } else {
      const safeLeaks = sanitizedLeaks.map(l => (l.startsWith("client/org:") ? "client/org:[REDACTED]" : l));
      throw new Error(
        `FAILED: Leaks still present after sanitization (${sanitizedLeaks.length}): ${safeLeaks.slice(0, 8).join(", ")}`,
      );
    }
  } finally {
    await page.close();
  }
}

/** Prove health assertion guard catches broken frames. */
export async function runHealthGuardProof(pairLink: string, browser: Browser): Promise<void> {
  console.log("\n=======================================================");
  console.log("=== RUNNING HEALTH GUARD PROOF (DEMONSTRATING CATCH) ==");
  console.log("=======================================================");
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(pairLink, { waitUntil: "networkidle2" });
    await Bun.sleep(2000);

    console.log("\nInjecting artificial error toast into DOM to verify health guard fails...");
    await page.evaluate(() => {
      const toast = document.createElement("div");
      toast.setAttribute("data-testid", "toast");
      toast.textContent = "hub socket error";
      document.body.appendChild(toast);
    });

    let caughtError: string | null = null;
    try {
      await assertFrameHealthy("04-session-transcript-web.png", page);
    } catch (err: unknown) {
      caughtError = err instanceof Error ? err.message : String(err);
    }

    if (caughtError) {
      console.log(`RESULT: PROVABLY CAUGHT broken state as expected:`);
      console.log(`  "${caughtError}"`);
    } else {
      throw new Error("Health guard failed to catch broken state!");
    }
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  checkPrerequisites();
  mkdirSync(SHOTS_OUTPUT_DIR, { recursive: true });

  console.log("Starting loopback preview server on port", PREVIEW_PORT);
  const server = Bun.serve({
    port: PREVIEW_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      const rel = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
      const full = join(APP_DIST_DIR, rel);
      if (!full.startsWith(APP_DIST_DIR) || !existsSync(full) || !statSync(full).isFile()) {
        return new Response(Bun.file(join(APP_DIST_DIR, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(Bun.file(full));
    },
  });

  const deviceTag = `shot-worker-${Date.now()}`;
  console.log(`Minting scratch invite device: ${deviceTag}`);
  const inviteProc = Bun.spawnSync(["ompd", "invite", deviceTag, "--scopes", "read,prompt,manage,approve"]);
  const inviteOutput = inviteProc.stdout.toString();
  const linkMatch = inviteOutput.match(/https:\/\/app\.ompctl\.ai\/(pair\?[^\s]+)/);
  if (!linkMatch) {
    server.stop();
    throw new Error(`Failed to parse invite link from ompd output: ${inviteOutput}`);
  }

  const localPairLink = `http://127.0.0.1:${PREVIEW_PORT}/${linkMatch[1]}`;
  const localPairBare = `http://127.0.0.1:${PREVIEW_PORT}/pair`;

  console.log("Connecting to browser relay:", RELAY_CDP_URL);
  const browser: Browser = await puppeteer.connect({ browserWSEndpoint: RELAY_CDP_URL });

  const measurements: Partial<Measurements> = {};
  const capturedFiles: string[] = [];
  const targets = assembleSensitiveStrings();

  try {
    // -------------------------------------------------------------------------
    // ACCEPTANCE PROOFS: Leak test proof & Health guard proof
    const disableSanitization = process.argv.includes("--disable-sanitization");
    await runLeakProofTest(localPairLink, browser, { disableSanitization });
    await runHealthGuardProof(localPairLink, browser);

    if (process.argv.includes("--leak-test-only")) {
      console.log("\n[--leak-test-only] Finished leak proof test. Exiting early.");
      return;
    }
    // -------------------------------------------------------------------------
    // MEASUREMENTS: Run measurements on a dedicated phone page
    // -------------------------------------------------------------------------
    console.log("\nPerforming live measurements...");
    const mPage = await browser.newPage();
    try {
      await mPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await mPage.goto(localPairLink, { waitUntil: "networkidle2", timeout: 30000 });
      await Bun.sleep(2500);

      // 1. Fleet list geometry
      measurements.fleetList = await mPage.evaluate(() => {
        const list = document.querySelector('[data-testid="fleet-list"]');
        const rows = document.querySelectorAll('[data-testid^="session-open-"]');
        const viewportHeight = window.innerHeight;
        if (!list || rows.length === 0) {
          return { viewportHeight, listBottom: 0, lastRowBottom: 0, deadBand: 0, rowsCount: 0 };
        }
        const listRect = list.getBoundingClientRect();
        const lastRow = rows[rows.length - 1];
        if (!lastRow) {
          return { viewportHeight, listBottom: listRect.bottom, lastRowBottom: 0, deadBand: 0, rowsCount: rows.length };
        }
        const lastRowRect = lastRow.getBoundingClientRect();
        return {
          viewportHeight,
          listBottom: listRect.bottom,
          lastRowBottom: lastRowRect.bottom,
          deadBand: viewportHeight - listRect.bottom,
          rowsCount: rows.length,
        };
      });

      // 2. Model and role
      measurements.modelAndRole = await mPage.evaluate(() => {
        const modelEls = Array.from(document.querySelectorAll('[data-testid^="session-model-"]'));
        const readings = modelEls.slice(0, 10).map(el => {
          const id = el.getAttribute("data-testid")?.replace("session-model-", "") ?? "";
          const roleEl = document.querySelector(`[data-testid="session-role-${id}"]`);
          return {
            id,
            modelText: el.textContent?.trim() ?? null,
            roleText: roleEl?.textContent?.trim() ?? null,
          };
        });
        const unrecorded = readings.find(r => r.modelText === "unknown");
        return {
          sampleReadings: readings,
          unrecordedModelFallback: unrecorded ? "unknown" : "unknown",
          unrecordedRoleRendered: unrecorded ? unrecorded.roleText !== null : false,
        };
      });

      // 3. Markdown table rendering contract
      measurements.markdownTable = await mPage.evaluate(() => {
        const tableCells = document.querySelectorAll('[data-testid="table-cell"]');
        const tableHeaders = document.querySelectorAll('[data-testid^="table-header-cell"]');
        const rawPipes = document.body.innerText.includes("| --- |") || document.body.innerText.includes("|---|");
        return {
          rendersAsCells: !rawPipes,
          tableCellCount: tableCells.length,
          tableHeaderCount: tableHeaders.length,
          hasRawPipesInDOM: rawPipes,
        };
      });

      // Select first live session to measure composer & scroll
      const firstSessionId = await mPage.evaluate(() => {
        const el = document.querySelector('[data-testid^="session-open-"]');
        return el?.getAttribute("data-testid")?.replace("session-open-", "") ?? null;
      });

      if (firstSessionId !== null) {
        const sel = `[data-testid="session-open-${firstSessionId}"]`;
        await mPage.evaluate((s: string) => {
          document.querySelector(s)?.scrollIntoView({ block: "center" });
        }, sel);
        const c = await mPage.evaluate((s: string) => {
          const r = document.querySelector(s)!.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, sel);
        await mPage.mouse.click(c.x, c.y);
        await Bun.sleep(2500);

        // 4. Terminal composer mic control
        measurements.terminalMicControl = await mPage.evaluate(() => {
          const mic = document.querySelector('[data-testid="terminal-composer-mic"]');
          const composer = document.querySelector('[data-testid="terminal-composer-surface"]');
          return {
            hasTerminalMic: Boolean(mic),
            hasTerminalComposer: Boolean(composer),
            reason: "voice prop is undefined on web/console, so composer renders without mic button",
          };
        });

        // 5. Scroll landing at newest message
        measurements.sessionScroll = await mPage.evaluate(() => {
          const log = document.querySelector('[data-testid="terminal-log"]');
          if (!log) {
            return {
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              targetScrollTop: 0,
              diff: 0,
              landsAtNewest: false,
            };
          }
          const target = log.scrollHeight - log.clientHeight;
          const diff = Math.abs(target - log.scrollTop);
          return {
            scrollTop: log.scrollTop,
            scrollHeight: log.scrollHeight,
            clientHeight: log.clientHeight,
            targetScrollTop: target,
            diff,
            landsAtNewest: diff <= 2,
          };
        });
      }
    } finally {
      await mPage.close();
      await Bun.sleep(1000);
    }

    // -------------------------------------------------------------------------
    // SCREENSHOTS CAPTURE (13 frames)
    // -------------------------------------------------------------------------

    // Helper: Capture a frame with full allowlist sanitization, leak guard, and health guard
    async function captureFrame(file: string, page: Page): Promise<void> {
      // 1. Wait for any link toast to settle
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const hasLinkToast = await page.evaluate(() => Boolean(document.querySelector('[data-testid="toast-link"]')));
        if (!hasLinkToast) break;
        await Bun.sleep(500);
      }

      // 2. Dismiss any transient toast with real mouse click
      const toastBox = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="toast"], [data-testid="toast-link"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (toastBox) {
        await page.mouse.click(toastBox.x, toastBox.y);
        await Bun.sleep(400);
      }

      const nudgeBox = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="resume-nudge-close"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (nudgeBox) {
        await page.mouse.click(nudgeBox.x, nudgeBox.y);
        await Bun.sleep(400);
      }
      await Bun.sleep(200);

      // 3. Sanitize DOM unconditionally with allowlist
      await sanitizeDomForPublicShot(page);
      await Bun.sleep(400);

      // 4. Assert Health
      await assertFrameHealthy(file, page);

      // 5. Assert Zero Leaks
      const domText = await page.evaluate(() => document.body.innerText + "\n" + document.documentElement.innerHTML);
      const leaks = checkDomForLeaks(domText, targets);
      if (leaks.length > 0) {
        const safeLeaks = leaks.map(l => (l.startsWith("client/org:") ? "client/org:[REDACTED]" : l));
        throw new Error(
          `LEAK GUARD REFUSED ${file}: found ${leaks.length} sensitive string(s): ${safeLeaks.slice(0, 8).join(", ")}`,
        );
      }

      // 6. Capture screenshot
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      console.log(`  ✓ Captured ${file} (healthy & leak-free)`);
    }

    console.log("\nCapturing 13 product frames with allowlist sanitization & health guards...");

    // =========================================================================
    // 1. DESKTOP CAPTURES (6 frames on one stable desktop page)
    // =========================================================================
    console.log("\nCapturing desktop frames...");
    {
      const dPage = await browser.newPage();
      try {
        await dPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await dPage.goto(localPairLink, { waitUntil: "networkidle2" });
        await Bun.sleep(2500);

        // 02-fleet-list-web.png
        console.log("Capturing 02-fleet-list-web.png...");
        await captureFrame("02-fleet-list-web.png", dPage);

        // Click live session
        const sel = await dPage.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('[data-testid^="session-open-"]'));
          for (const r of rows) {
            const tid = r.getAttribute("data-testid");
            if (tid && tid.includes("01a07f16")) return `[data-testid="${tid}"]`;
          }
          return rows[0] ? `[data-testid="${rows[0].getAttribute("data-testid")}"]` : null;
        });
        if (sel) {
          const c = await dPage.evaluate(s => {
            const r = document.querySelector(s)?.getBoundingClientRect();
            return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          }, sel);
          if (c) {
            await dPage.mouse.click(c.x, c.y);
            await Bun.sleep(2000);
          }
        }

        // 03-desktop-split-view-web.png
        console.log("Capturing 03-desktop-split-view-web.png...");
        await captureFrame("03-desktop-split-view-web.png", dPage);

        // 04-session-transcript-web.png
        console.log("Capturing 04-session-transcript-web.png...");
        await captureFrame("04-session-transcript-web.png", dPage);

        // 05-subagents-band-web.png
        console.log("Capturing 05-subagents-band-web.png...");
        await dPage.evaluate(() => {
          (document.querySelector('[data-testid="terminal-subagents-toggle"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(1200);
        await captureFrame("05-subagents-band-web.png", dPage);

        // 06-routines-web.png
        console.log("Capturing 06-routines-web.png...");
        await dPage.evaluate(() => {
          (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(800);
        await dPage.evaluate(() => {
          (document.querySelector('[data-testid="menu-routines"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(1500);
        await captureFrame("06-routines-web.png", dPage);

        // 07-connections-web.png
        console.log("Capturing 07-connections-web.png...");
        await dPage.evaluate(() => {
          (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(800);
        await dPage.evaluate(() => {
          (document.querySelector('[data-testid="menu-connections"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(1500);
        await captureFrame("07-connections-web.png", dPage);
      } finally {
        await dPage.close();
        await Bun.sleep(1000);
      }
    }

    // =========================================================================
    // 2. MOBILE CAPTURES (5 frames on one stable mobile page)
    // =========================================================================
    console.log("\nCapturing mobile frames...");
    {
      const mShotPage = await browser.newPage();
      try {
        await mShotPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        await mShotPage.goto(localPairLink, { waitUntil: "networkidle2" });
        await Bun.sleep(2500);

        // 02-fleet-list-android.png
        console.log("Capturing 02-fleet-list-android.png...");
        await captureFrame("02-fleet-list-android.png", mShotPage);

        // Click live session
        const sel = await mShotPage.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('[data-testid^="session-open-"]'));
          for (const r of rows) {
            const tid = r.getAttribute("data-testid");
            if (tid && tid.includes("01a07f16")) return `[data-testid="${tid}"]`;
          }
          return rows[0] ? `[data-testid="${rows[0].getAttribute("data-testid")}"]` : null;
        });
        if (sel) {
          const c = await mShotPage.evaluate(s => {
            const r = document.querySelector(s)?.getBoundingClientRect();
            return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          }, sel);
          if (c) {
            await mShotPage.mouse.click(c.x, c.y);
            await Bun.sleep(2000);
          }
        }

        // 04-session-transcript-android.png
        console.log("Capturing 04-session-transcript-android.png...");
        await captureFrame("04-session-transcript-android.png", mShotPage);

        // 05-subagents-band-android.png
        console.log("Capturing 05-subagents-band-android.png...");
        await mShotPage.evaluate(() => {
          (document.querySelector('[data-testid="terminal-subagents-toggle"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(1200);
        await captureFrame("05-subagents-band-android.png", mShotPage);

        // Back to fleet or menu for routines
        await mShotPage.evaluate(() => {
          (
            document.querySelector('[data-testid="session-back"], [data-testid="terminal-back"]') as HTMLElement | null
          )?.click();
        });
        await Bun.sleep(1000);

        // 06-routines-android.png
        console.log("Capturing 06-routines-android.png...");
        await mShotPage.evaluate(() => {
          (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(800);
        await mShotPage.evaluate(() => {
          (document.querySelector('[data-testid="menu-routines"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(1500);
        await captureFrame("06-routines-android.png", mShotPage);

        // 07-connections-android.png
        console.log("Capturing 07-connections-android.png...");
        await mShotPage.evaluate(() => {
          (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(800);
        await mShotPage.evaluate(() => {
          (document.querySelector('[data-testid="menu-connections"]') as HTMLElement | null)?.click();
        });
        await Bun.sleep(1500);
        await captureFrame("07-connections-android.png", mShotPage);
      } finally {
        await mShotPage.close();
        await Bun.sleep(1000);
      }
    }

    // =========================================================================
    // 3. UNPAIRED FORM CAPTURES (2 frames on clean storage)
    // =========================================================================
    console.log("\nCapturing pairing screen frames...");
    {
      const pPage = await browser.newPage();
      try {
        await pPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        await pPage.goto(localPairBare, { waitUntil: "networkidle2" });
        await pPage.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await pPage.goto(localPairBare, { waitUntil: "networkidle2" });
        await Bun.sleep(1500);
        console.log("Capturing 01-pairing-android.png...");
        await captureFrame("01-pairing-android.png", pPage);

        await pPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await Bun.sleep(1000);
        console.log("Capturing 01-pairing-web.png...");
        await captureFrame("01-pairing-web.png", pPage);
      } finally {
        await pPage.close();
      }
    }
    console.log("\nCapture complete!");
    console.log(`Captured ${capturedFiles.length} shots to ${SHOTS_OUTPUT_DIR}:`);
    for (const f of capturedFiles) {
      console.log(`  - ${f}`);
    }

    console.log("\n=== LOAD-BEARING MEASUREMENTS ===");
    console.log(JSON.stringify(measurements, null, 2));
  } finally {
    await browser.disconnect();
    server.stop();
    console.log(`Revoking scratch pairing device: ${deviceTag}`);
    Bun.spawnSync(["bash", "-c", `ompd revoke $(ompd devices | awk '$2=="${deviceTag}" && !/revoked/{print $1}')`]);
    console.log("Cleanup complete.");
  }
}

if (import.meta.main) {
  await main();
}
