/**
 * The policy engine.
 *
 * `session/request_permission` is an enforcement *hook*. This is the policy. A
 * remote client's choice is evidence for a decision, never the decision itself:
 * the supervisor consults `evaluate()` first and may override any client reply.
 *
 * `evaluate()` is pure and total. It performs no I/O and must never throw --
 * the caller treats a throw as a denial, but relying on that would make the
 * failure mode silent, so every branch returns a decision explicitly.
 *
 * `resolveMountPath` is the one deliberate exception to "no I/O" in this file.
 * It has to be: a mount decision taken on a path nobody canonicalized is a
 * decision about a string rather than about a directory, and resolving a
 * symlink is a syscall. It is not on `evaluate()`'s path and, like everything
 * else here, it never throws.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  type Policy,
  type PolicyContext,
  type PolicyDecision,
  SCOPE_APPROVE,
  SCOPE_PROMPT,
  SCOPE_READ,
} from "./contracts.ts";

/**
 * Tools that only read. Cheap to allow so a phone is not a nag machine -- but
 * "read-only" is about the *filesystem*, not about secrecy. A read of
 * `~/.ssh/id_ed25519` is exfiltration, so these still pass the path checks.
 *
 * `webview_observe`/`webview_screenshot` join this table for the same reason
 * `read` does: neither mutates the page or anything on disk, so gating them
 * like a shell command would make a phone a nag machine for the one thing an
 * agent should be doing constantly -- looking. `webview_navigate`,
 * `webview_click`, and `webview_type` are deliberately absent: those are the
 * side effects `docs/browser.md` says must reach a human.
 */
const READ_ONLY_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  ls: true,
  list: true,
  lsp: true,
  todo: true,
  web_search: true,
  recall: true,
  reflect: true,
  webview_observe: true,
  webview_screenshot: true,
};

/** Tools with no filesystem reach at all; a path check is meaningless for them. */
const NON_FILESYSTEM_TOOLS: Record<string, true> = {
  todo: true,
  web_search: true,
  recall: true,
  reflect: true,
  webview_observe: true,
  webview_screenshot: true,
};

/**
 * Paths that are secret regardless of where the workspace is. Reading any of
 * these is escalation, so they are never on a fast path.
 */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /(^|\/)credentials(\.json)?$/,
  /(^|\/)\.config\/gh(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/,
  /(^|\/)\.omp\/agent\/agent\.db$/,
  /(^|\/)\.ompd(\/|$)/,
];

/**
 * Roots a container mount must never name, layered on top of
 * `SECRET_PATH_PATTERNS` rather than restating any of it.
 *
 * A mount is a much bigger door than a single gated tool call: everything
 * under it is visible to every tool at once, for as long as the container
 * runs, unfiltered by any decision `DefaultPolicy` makes afterward. So beyond
 * the credential files a read/write is denied from touching, a mount also
 * refuses filesystem and home-directory roots outright, and the whole `.omp`
 * state tree rather than only the credential DB inside it -- `agent.db` is
 * enough to gate one read, but not enough to hand the directory over whole.
 */
const DANGEROUS_MOUNT_ROOT_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/root\/?$/,
  /^\/(Users|home)\/[^/]+\/?$/,
  /(^|\/)\.omp(\/|$)/,
];

/**
 * Why `hostPath` must never be mounted whole into a container, or null when
 * it may be. `hostPath` is expected already resolved to absolute; a relative
 * path is the caller's bug, not something this function normalizes.
 */
export function dangerousMountReason(hostPath: string): string | null {
  const norm = hostPath.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  for (const pattern of DANGEROUS_MOUNT_ROOT_PATTERNS) {
    if (pattern.test(norm)) return `matches protected root ${pattern.source}`;
  }
  const secret = matchSecret(norm);
  if (secret !== null) return `matches secret path pattern ${secret}`;
  return null;
}

/**
 * Directory trees a mount may never name, reach into, or contain.
 *
 * These are whole trees because nothing inside them is a workspace. `/etc`
 * holds `passwd`, `sudoers`, and every trust store on the machine; `/var/root`
 * is root's home directory and therefore root's credentials; `/System`,
 * `/usr`, `/bin`, `/sbin`, and `/Library` are the OS itself.
 *
 * The kernel and device interfaces are here for a different reason, and `/dev`
 * is the one the review demonstrated. A read-write `/dev` is not a file leak,
 * it is the host's block devices: the raw disks (`/dev/rdisk0` here,
 * `/dev/sda` on Linux), which make every filesystem permission on the host
 * advisory; `/dev/mem` and `/dev/kmem` where a kernel still exposes them,
 * which is the host's live memory; and, because the guest runs as root with
 * `mknod`, the ability to hand ITSELF a device node for anything it can name.
 * That is why `/dev` is a tree and not an exact match: an exact rule refuses
 * the directory and then allows `--volume /dev/rdisk0:/dev/rdisk0:rw`, which
 * is the whole attack in one argument. `/proc` and `/sys` are the same shape
 * by other means, since `/proc/sys/kernel`, `/proc/<pid>/mem` and
 * `/sys/kernel/security` are writes into the running kernel. Both are listed
 * even though macOS has neither, because this daemon is meant to run on Linux
 * too and a set that is right on one platform only has to be got right twice.
 *
 * `/boot`, `/lib` and `/lib64` are code the machine executes on the next boot
 * or the next `execve`. `/run` is its runtime state: systemd's private
 * sockets, the D-Bus system bus, udev's database, and on many systems the
 * docker or podman socket, which is a container runtime handing out root.
 * `/var/lib` is where packages keep their databases, `/var/lib/docker` and
 * `/var/lib/containers` included, so it is the same escalation by a slower
 * road, and `/var/run` is the older spelling of `/run`.
 *
 * `/opt` is a decision rather than a reflex, and it goes in. On this machine
 * `/opt/homebrew` is the operator's entire toolchain and `/opt/podman` is a
 * container runtime install (both verified present: darwin 25.5.0, arm64), and
 * on Linux `/opt` is where vendor packages put their binaries. A writable
 * mount there does not read a secret, it replaces a program the operator, and
 * this daemon, which finds its runtime by name on PATH, will later execute.
 * That is host code execution arriving through a mount instead of through a
 * gated tool call. The cost is over-refusing an operator who genuinely keeps a
 * project in `/opt/thing`; they get a reason naming the directory and can move
 * it, which is the cheap side of the trade.
 *
 * `/srv` is the same question and the answer is no, which is the asymmetry
 * worth stating out loud. It does not exist on macOS at all (verified), and
 * the FHS defines it as site-specific data served by this system, explicitly
 * the one tree a distribution must not write into. No OS code to swap, no
 * credential store, no kernel interface: the mechanism that justifies every
 * entry above is simply absent there, while a served web root or git mirror
 * under `/srv` is a plausible workspace. Refusing it would cost the ordinary
 * case and buy nothing nameable.
 *
 * Both spellings of the macOS firmlinked directories are listed on purpose.
 * `realpathSync("/etc")` returns `/private/etc`, `realpathSync("/var")`
 * returns `/private/var`, and `/var/lib` and `/var/run` return
 * `/private/var/lib` and `/private/var/run` (all verified: darwin 25.5.0,
 * APFS), so canonicalization moves the path to the `/private` spelling and a
 * list that named only `/etc` would match nothing after canonicalizing. The
 * unprefixed spelling stays because canonicalization is allowed to fail (see
 * `canonicalizeAsFarAsPossible`) and the check must still refuse in that case.
 * The other new entries get no `/private` twin, because macOS has no firmlink
 * for them: `/private/dev` and `/private/run` do not exist here (verified), so
 * an entry for either would defend nothing.
 *
 * An entry for a directory that exists on neither platform still refuses, and
 * that is the mechanism rather than an accident. `canonicalizeAsFarAsPossible`
 * walks up to `/`, which resolves, and re-appends the missing tail verbatim,
 * so an absent `/proc` is judged as the string `/proc` and caught by its own
 * entry rather than sliding past as something unrecognised. The tests assert
 * that walk instead of assuming it.
 */
const PROTECTED_TREES: string[] = [
  "/etc",
  "/private/etc",
  "/root",
  "/var/root",
  "/private/var/root",
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/boot",
  "/lib",
  "/lib64",
  "/var/lib",
  "/private/var/lib",
  "/var/run",
  "/private/var/run",
  "/opt",
  "/Volumes/.timemachine",
];

/**
 * Directories refused as themselves, and refused as an ancestor, but whose
 * descendants are judged on their own merits.
 *
 * `/Users` and `/home` cannot be whole trees: mounting a folder under a home
 * directory is the ordinary case this daemon exists to serve. What they must
 * refuse is being named *themselves*, because `/Users` is every operator's
 * home at once, which is the hole the review demonstrated. The per-home rule
 * in `DANGEROUS_MOUNT_ROOT_PATTERNS` covers `/Users/<name>` one level down.
 *
 * `/var` and `/private/var` are here rather than in `PROTECTED_TREES` for the
 * same reason, and it is not a compromise: `os.tmpdir()` on macOS is
 * `/var/folders/<hash>/T`, which canonicalizes under `/private/var`, so every
 * scratch directory a caller could legitimately mount lives inside that tree.
 * Refusing the tree would refuse the ordinary case; refusing the directory
 * itself, plus `/var/root`, `/var/lib` and `/var/run` as trees above, refuses
 * what is actually dangerous.
 *
 * `/Volumes` is the macOS spelling of the same shape, and it is exact for the
 * same reason. Named itself it is every mounted volume at once: the system
 * volume, a Time Machine store, and any disk image the operator or an attacker
 * has attached. It must stay exact and must not be promoted to a tree later,
 * because an external volume legitimately holds a workspace: on this machine
 * the operator's own checkouts mirror onto an external SSD under
 * `/Volumes/dev`, so a tree rule would refuse an ordinary mount and the
 * refusal would read as a bug rather than as policy. Same trade as `/var` and
 * `$TMPDIR`.
 *
 * The obvious dangerous descendant needs no rule, because the filesystem folds
 * it already: `/Volumes/Macintosh HD` is a symlink whose `realpathSync` is `/`
 * (verified: darwin 25.5.0), so the `/` entry refuses it before any comparison
 * reaches this list. `/Volumes/.timemachine` does need one, and it is the one
 * `/Volumes` descendant in `PROTECTED_TREES`: it is where macOS automounts
 * backup destinations, so read-write it is every credential the operator has
 * ever had at rest plus the ability to corrupt the backups, and nobody keeps a
 * workspace in a dotted automount directory. That is the `/Users` argument
 * about credentials at rest, not a second opinion about volumes.
 *
 * What is left uncovered, said plainly: a system or data volume an operator
 * mounts under `/Volumes` by hand has its own filesystem root, so nothing
 * canonicalizes it into `/` and it is judged on merit like any other volume.
 * Telling one apart from an external disk needs content inspection, which is
 * more mechanism than this list is, so it is named here rather than guessed at.
 * Linux has no `/Volumes`, and the entry costs nothing there because the
 * ancestor walk re-appends the absent tail and this rule refuses a directory
 * nobody has.
 */
const PROTECTED_EXACT: string[] = ["/", "/Users", "/home", "/var", "/private/var", "/Volumes"];

/**
 * A resolved mount path, or the reason it is refused. Never a throw: a caller
 * turns the reason into its own error type (`ProvisionError` in the daemon's
 * container backend) and a thrown string would force every caller to guess at
 * which failures are refusals and which are bugs.
 */
export type MountResolution = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Canonicalize `hostPath`, then decide whether it may be mounted, and return
 * the canonical path the caller must put into argv.
 *
 * The order is the entire point. `dangerousMountReason` alone, applied to the
 * operator's literal string, is defeated by any spelling of the same
 * directory. The review proved it: against the old check `/Users/jwaldrip/.`,
 * `/Users/jwaldrip/..`, `//Users/jwaldrip`, `/etc`, and `/var/root` were all
 * ALLOWED, and the argv it produced was
 * `--volume /Users/jwaldrip/.:/Users/jwaldrip/.:rw`, a read-write mount of the
 * whole home directory, `~/.ssh` and `~/.aws` and `~/.omp` and `~/.ompd`
 * included. Canonicalizing first collapses every spelling onto one path, and
 * then one list of protected directories is enough.
 *
 * Returning the CANONICAL path is not a convenience. Returning the original
 * would reintroduce the bug one layer down, because the runtime resolves the
 * string again on its own side, so the path this function judged and the path
 * that gets bind-mounted would be two different decisions.
 *
 * TOCTOU-aware, not TOCTOU-free, and worth saying plainly. The path is
 * resolved once here; if a component is swapped for a symlink between this
 * call and the runtime's own resolution, nothing detects it. What this does
 * buy is that the mounted path is the one that was checked rather than an
 * operator-supplied string re-resolved later, which removes the trivially
 * exploitable version of that race and leaves only the racing-a-syscall one.
 *
 * `opts.home` is the daemon's own state directory, which cannot be a static
 * pattern because `OMPD_HOME` moves it. `opts.mustExist` refuses a path that
 * is not there: a mount source that does not exist is a typo or a race, and
 * the runtimes that tolerate it create a root-owned empty directory on the
 * host instead.
 */
export function resolveMountPath(hostPath: string, opts: { home?: string; mustExist?: boolean } = {}): MountResolution {
  if (hostPath.length === 0) return { ok: false, reason: "mount path is empty" };
  // A NUL byte truncates the path at the syscall boundary, so `/tmp/ok\0/etc`
  // is checked as one path and opened as another. `realpathSync` would throw
  // on it anyway; refusing it by name says why.
  if (hostPath.includes("\0")) return { ok: false, reason: "mount path contains a NUL byte" };
  if (!isAbsolute(hostPath)) {
    return { ok: false, reason: `mount path must be absolute, got ${JSON.stringify(hostPath)}` };
  }

  // `resolve` does the lexical half: `.` and `..` segments collapse, duplicate
  // separators collapse (`//Users/x` becomes `/Users/x`), and a trailing slash
  // goes away. It cannot see a symlink, which is what the next step is for.
  //
  // On this runtime it is currently redundant, and it is kept anyway. Measured:
  // Bun 1.3.14's `realpathSync` collapses `..` even through a component that
  // does not exist, so `realpathSync("/tmp/absent/..")` returns `/private/tmp`
  // rather than throwing ENOENT the way strict POSIX `realpath(3)` would. No
  // test can fail with this line removed while that holds. But the segment
  // comparison downstream cannot interpret a `..`, so a stricter `realpath`
  // would leave literal `..` entries in the path being judged and the check
  // would fail OPEN. One cheap call removes that dependency on behaviour
  // nothing promises.
  const lexical = resolvePath(hostPath);
  const canonical = canonicalizeAsFarAsPossible(lexical);

  const note = canonical.path === hostPath ? "" : `; ${JSON.stringify(hostPath)} canonicalizes to ${canonical.path}`;
  const refusal =
    protectedPathReason(canonical.path) ??
    dangerousMountReason(canonical.path) ??
    daemonHomeReason(canonical.path, opts.home);
  if (refusal !== null) return { ok: false, reason: `${refusal}${note}` };

  // Reported after the policy check, not before, so a protected path is
  // refused for being protected rather than for a permissions accident.
  //
  // Anything `realpath` refused for a reason other than "does not exist" is
  // refused here, with no existence test in front of it. `existsSync` cannot
  // tell "absent" from "cannot stat", so gating on it let a path under a
  // directory the daemon cannot open through: EACCES on the parent, `false`
  // from `existsSync`, and an unverified path approved. Without a successful
  // `realpath` there is no proof the tail is not a symlink out of the tree
  // that was just approved, so the answer is no. An operator who meant it can
  // make the path readable; a check that guesses cannot be un-guessed.
  if (canonical.unresolvable !== null) {
    return { ok: false, reason: `cannot canonicalize ${canonical.path} (${canonical.unresolvable})${note}` };
  }
  if (opts.mustExist === true && !existsSync(canonical.path)) {
    return { ok: false, reason: `${canonical.path} does not exist${note}` };
  }

  return { ok: true, path: canonical.path };
}

/** How far `realpath` got, and why it stopped. */
interface CanonicalPath {
  /** Canonical for as many leading components as the filesystem confirmed. */
  path: string;
  /** `null` when the whole path resolved, or when it merely does not exist. */
  unresolvable: string | null;
}

/**
 * `realpath` the deepest resolvable prefix of `lexical` and re-append the rest.
 *
 * The attack this stops is a mount whose PARENT is a symlink: `/tmp/esc/etc`
 * where `/tmp/esc -> /`. Resolving only when the whole path exists would leave
 * that case judged as the string `/tmp/esc/etc`, which matches no protected
 * directory, while the runtime would happily bind `/etc`. Verified on this
 * machine: `realpathSync("/tmp/esc/etc")` returns `/private/etc`.
 *
 * Walking ancestors also covers the absent-path case the same way. For a path
 * that is not there yet, `realpath` fails outright, so the deepest existing
 * ancestor is canonicalized and the missing tail is re-appended: an absent
 * `/etc/nope` becomes `/private/etc/nope` and is refused by the tree, rather
 * than sliding through as an unrecognised string.
 *
 * The re-appended tail is never symlink-resolved, because there is nothing to
 * resolve it against. `unresolvable` carries the reason `realpath` refused the
 * full path when that reason is not "does not exist", so the caller can fail
 * closed on a path that is present but opaque (`/var/root` answers `EACCES`
 * here) instead of silently trusting a half-resolved string.
 */
function canonicalizeAsFarAsPossible(lexical: string): CanonicalPath {
  const segments = lexical.split("/").filter(segment => segment.length > 0);
  let firstError: string | null = null;
  for (let take = segments.length; take >= 0; take--) {
    const prefix = `/${segments.slice(0, take).join("/")}`;
    let resolved: string;
    try {
      resolved = realpathSync(prefix);
    } catch (err) {
      if (firstError === null) firstError = errorCode(err);
      continue;
    }
    const tail = segments.slice(take);
    if (tail.length === 0) return { path: resolved, unresolvable: null };
    const joined = resolved === "/" ? `/${tail.join("/")}` : `${resolved}/${tail.join("/")}`;
    return { path: joined, unresolvable: firstError === "ENOENT" ? null : firstError };
  }
  // Not reachable while `/` resolves, but a check that assumes it does would
  // fail open on the one machine where it does not.
  return { path: lexical, unresolvable: firstError ?? "unresolvable" };
}

function errorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const { code } = err;
    if (typeof code === "string") return code;
  }
  return err instanceof Error ? err.message : "unknown error";
}

/**
 * Why `canonical` is a protected directory, is inside one, or contains one.
 *
 * The ancestor half matters as much as the descendant half: mounting `/Users`
 * hands over every home directory on the machine without ever naming one, and
 * mounting `/private` hands over `/private/etc` the same way.
 *
 * The three rules run in that order (equal, inside, contains) so the reason an
 * operator reads names the directory they typed. Checked the other way round,
 * `/` would be refused for "containing /etc", which is true and useless.
 *
 * Comparison folds case, and folding rather than trusting `realpath` is
 * deliberate. On this machine's case-insensitive volume `realpathSync` does
 * normalize case for components that exist (`/USERS` returns `/Users`,
 * `/Users/JWALDRIP` returns `/Users/jwaldrip`), but two paths never reach that
 * normalization: the tail `canonicalizeAsFarAsPossible` re-appends verbatim,
 * and anything on a case-sensitive volume. Folding costs an over-refusal of a
 * directory literally named `/ETC` on a case-sensitive volume, which nobody
 * mounts, and buys a check that does not depend on the volume's format.
 */
function protectedPathReason(canonical: string): string | null {
  const candidate = foldedSegments(canonical);
  for (const dir of [...PROTECTED_TREES, ...PROTECTED_EXACT]) {
    const target = foldedSegments(dir);
    if (candidate.length === target.length && isSegmentPrefix(target, candidate)) {
      return `${dir} is a protected directory`;
    }
  }
  for (const tree of PROTECTED_TREES) {
    if (isSegmentPrefix(foldedSegments(tree), candidate)) {
      return `it is inside the protected directory ${tree}`;
    }
  }
  for (const dir of [...PROTECTED_TREES, ...PROTECTED_EXACT]) {
    if (isSegmentPrefix(candidate, foldedSegments(dir))) {
      return `it contains the protected directory ${dir}`;
    }
  }
  return null;
}

/** Why `canonical` is the daemon's own state, or null. */
function daemonHomeReason(canonical: string, home: string | undefined): string | null {
  if (home === undefined || home.length === 0) return null;
  // The daemon's home is canonicalized too. `OMPD_HOME=/tmp/state` against a
  // canonical `/private/tmp/state` would otherwise compare unequal and let a
  // caller mount the daemon's own token store.
  const resolvedHome = canonicalizeAsFarAsPossible(resolvePath(home)).path;
  if (!isInside(resolvedHome, canonical)) return null;
  return `it is the daemon's own state directory ${resolvedHome}`;
}

/** Path segments, case-folded, with separators and empty segments dropped. */
function foldedSegments(path: string): string[] {
  return path
    .split("/")
    .filter(segment => segment.length > 0)
    .map(segment => segment.toLowerCase());
}

/** Whether `prefix` is a segment-wise prefix of `of`, equal lengths included. */
function isSegmentPrefix(prefix: string[], of: string[]): boolean {
  if (prefix.length > of.length) return false;
  return prefix.every((segment, i) => of[i] === segment);
}

/**
 * Schemes the agent's WebView may load. Everything else is refused.
 *
 * `about:blank` is where a fresh sandbox starts. Beyond that, a driveable page
 * is a web page, and every other scheme a URL bar accepts is a way out of the
 * sandbox rather than a place to browse: `file:` reads the app's own container,
 * `tel:`/`sms:`/`mailto:` and any app scheme hand the request to another app
 * through the OS, and `javascript:` is script injection wearing a URL. None of
 * those are things an operator should be asked to approve, so they are refused
 * before an approval is ever raised.
 */
const DRIVEABLE_SCHEMES: Record<string, true> = { "http:": true, "https:": true };

/** Where a fresh sandbox starts, allowed without being a scheme anyone browses. */
const BLANK_PAGE = "about:blank";

/**
 * Why the WebView must not load `url`, or null when it may.
 *
 * Enforced twice on purpose, and the two are not redundant. This is the check
 * on a URL the agent supplied, and it runs before the operator is asked
 * anything. The other is the device's own `onShouldStartLoadWithRequest`, which
 * sees what this cannot: a redirect the page performed and a link the agent
 * clicked, neither of which passed through any tool call.
 */
export function undriveableUrlReason(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === BLANK_PAGE) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "not a URL";
  }
  if (DRIVEABLE_SCHEMES[parsed.protocol] !== true) return `scheme ${parsed.protocol} is not driveable`;
  // A URL with no host is not a page: `http:///etc/passwd` parses, and on some
  // platforms resolves to something local.
  if (parsed.hostname.length === 0) return "no host";
  return null;
}

/**
 * Commands that are never auto-allowed regardless of mode, because a mistake is
 * unrecoverable or exfiltrates credentials.
 */
const CRITICAL_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/,
  /\bmkfs(\.|\b)/,
  /\bdd\s+[^|]*\bof=\/dev\//,
  /\b(shutdown|reboot|halt)\b/,
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh/,
  /\bwget\b[^|]*\|\s*(ba)?sh/,
  /\bgit\s+push\b[^&;|]*--force(?!-with-lease)/,
  /\b(aws|gcloud|az)\s+.*\b(delete|destroy|rm)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\bkubectl\s+delete\b/,
  /\.ssh\/|\bid_(rsa|ed25519)\b/,
  /\b(AWS_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN)\b/,
];

/** Split a shell line the way an operator reads it, not the way bash parses it. */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n|(?<!&)&(?!&)/)
    .map(s => s.trim())
    .filter(Boolean);
}

export interface PolicyConfig {
  /**
   * `strict`  - everything except non-filesystem read-only tools needs a human.
   * `standard`- reads and writes inside the workspace are allowed; everything
   *             else prompts.
   * `trusted` - additionally auto-allows non-critical shell commands.
   *
   * There is deliberately no mode that auto-allows critical commands or secret
   * paths, because such a mode is indistinguishable from having no policy.
   */
  mode: "strict" | "standard" | "trusted";
  /** Extra command regexes treated as critical. */
  extraCritical?: RegExp[];
  /**
   * Roots an agent may touch without prompting. Defaults to the agent's cwd.
   * Useful when a repo's worktrees live outside it.
   */
  workspaceRoots?: string[];
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = { mode: "standard" };

export class DefaultPolicy implements Policy {
  #config: PolicyConfig;
  #critical: RegExp[];

  constructor(config: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    this.#config = config;
    // Strip the global flag: `RegExp.test` on a `/g` regex advances lastIndex,
    // so the same pattern would match on one call and miss on the next. A
    // stateful matcher in a security check is a bug that only shows up under
    // load, which is the worst time to find it.
    this.#critical = [...CRITICAL_COMMAND_PATTERNS, ...(config.extraCritical ?? [])].map(p =>
      p.flags.includes("g") || p.flags.includes("y") ? new RegExp(p.source, p.flags.replace(/[gy]/g, "")) : p,
    );
  }

  evaluate(ctx: PolicyContext): PolicyDecision {
    const { agent, tool, input, actor } = ctx;
    const scopes = new Set(actor.scopes);

    // A device with no scope at all cannot influence anything.
    if (scopes.size === 0) {
      return { action: "deny", reason: "actor has no scopes", rule: "scope" };
    }

    const isRead = READ_ONLY_TOOLS[tool] === true;

    if (isRead) {
      if (!scopes.has(SCOPE_READ)) {
        return { action: "deny", reason: `read requires ${SCOPE_READ} scope`, rule: "scope:read" };
      }
      if (NON_FILESYSTEM_TOOLS[tool]) {
        return { action: "allow", reason: "read-only tool with no filesystem reach", rule: "read-only" };
      }
      const path = extractPath(input);
      if (path === null) {
        // A filesystem read tool whose target we cannot see is not a fast path.
        return { action: "prompt", reason: "read target not determinable", rule: "read:opaque" };
      }
      const secret = matchSecret(path);
      if (secret) {
        return {
          action: "deny",
          reason: "read targets a secret path",
          rule: `secret:${secret}`,
        };
      }
      if (!this.#inWorkspace(agent.cwd, path)) {
        return { action: "prompt", reason: "read outside workspace", rule: "read:escape" };
      }
      return { action: "allow", reason: "read inside workspace", rule: "read:workspace" };
    }

    // Everything below mutates or executes, so it needs prompt scope at minimum.
    if (!scopes.has(SCOPE_PROMPT) && !scopes.has(SCOPE_APPROVE)) {
      return { action: "deny", reason: "actor lacks prompt and approve scope", rule: "scope" };
    }

    const command = extractCommand(input);
    if (command !== null) {
      const critical = this.#criticalMatch(command);
      if (critical) {
        if (!scopes.has(SCOPE_APPROVE)) {
          return {
            action: "deny",
            reason: `critical command and actor lacks ${SCOPE_APPROVE} scope`,
            rule: `critical:${critical}`,
          };
        }
        // Not even `trusted` mode auto-allows these.
        return {
          action: "prompt",
          reason: "critical command requires explicit human approval",
          rule: `critical:${critical}`,
        };
      }
      if (this.#config.mode === "trusted") {
        return { action: "allow", reason: "non-critical command, trusted mode", rule: "trusted" };
      }
      return { action: "prompt", reason: "shell command", rule: "shell" };
    }

    const path = extractPath(input);
    if (path !== null) {
      const secret = matchSecret(path);
      if (secret) {
        return { action: "deny", reason: "write targets a secret path", rule: `secret:${secret}` };
      }
      if (this.#config.mode === "strict") {
        return { action: "prompt", reason: "strict mode prompts on every write", rule: "strict" };
      }
      if (this.#inWorkspace(agent.cwd, path)) {
        return { action: "allow", reason: "write inside workspace", rule: "write:workspace" };
      }
      return { action: "prompt", reason: "write outside workspace", rule: "write:escape" };
    }

    return { action: "prompt", reason: "no rule matched; defaulting to human", rule: "default" };
  }

  #inWorkspace(cwd: string, path: string): boolean {
    const roots = this.#config.workspaceRoots ?? [cwd];
    return roots.some(root => isInside(root, path, cwd));
  }

  #criticalMatch(command: string): string | null {
    const segments = [command, ...commandSegments(command)];
    for (const p of this.#critical) {
      for (const seg of segments) {
        if (p.test(seg)) return p.source.slice(0, 40);
      }
    }
    return null;
  }
}

function matchSecret(path: string): string | null {
  const norm = path.replace(/\\/g, "/");
  for (const p of SECRET_PATH_PATTERNS) {
    if (p.test(norm)) return p.source.slice(0, 32);
  }
  return null;
}

/** Pull a shell command out of a tool input, whatever the tool calls the field. */
export function extractCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Pull a filesystem path out of a tool input. */
export function extractPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target", "pattern"]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * True when `child` resolves inside `parent`.
 *
 * Naive prefix comparison is wrong twice over: `/a/bc` starts with `/a/b`, and
 * `..` segments escape. Both are handled by normalizing to segments and
 * requiring `parent` to be a segment-wise prefix.
 *
 * Note this is lexical. It cannot see through symlinks, so a symlink inside the
 * workspace pointing at `/etc` reads as inside. Resolving that needs I/O, which
 * `evaluate()` must not do; the supervisor resolves real paths before calling.
 */
export function isInside(parent: string, child: string, base = parent): boolean {
  const segs = (p: string): string[] => {
    const abs = p.startsWith("/") ? p : `${base.replace(/\/+$/, "")}/${p}`;
    const out: string[] = [];
    for (const seg of abs.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return out;
  };
  const p = segs(parent);
  const c = segs(child);
  if (c.length < p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}

export type AcpOptionId = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** Map a policy decision plus an optional human reply onto an ACP option id. */
export function toAcpOption(
  decision: PolicyDecision,
  humanChoice?: { choice: "allow" | "deny"; scope?: "once" | "always" },
): AcpOptionId {
  if (decision.action === "allow") return "allow_once";
  if (decision.action === "deny") return "reject_once";
  // `prompt` and no human answered: fail closed.
  if (!humanChoice) return "reject_once";
  const always = humanChoice.scope === "always";
  if (humanChoice.choice === "allow") return always ? "allow_always" : "allow_once";
  return always ? "reject_always" : "reject_once";
}
