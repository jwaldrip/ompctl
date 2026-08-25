/**
 * Mount policy: the part of the policy engine that touches the filesystem.
 *
 * Split out of `policy.ts` for one measured reason. `policy.ts` is imported by
 * the mobile app -- `packages/app/src/browser/WebViewDriver.tsx` needs
 * `undriveableUrlReason` -- and Metro cannot resolve `node:fs` or `node:path`,
 * so a single `import ... from "node:path"` at that module's scope made the app
 * unbundlable for every native platform at once. Measured on 2026-08-25: with
 * the imports there, `react-native bundle` fails with
 * `Unable to resolve module node:path from packages/core/src/policy.ts` for
 * ios, android, macos and windows alike.
 *
 * So the rule this file encodes is a boundary, not a preference: anything in
 * `@ompd/core` that reaches the filesystem lives here, and `policy.ts` stays
 * free of Node builtins so a phone can import it. `packages/core/test/policy.test.ts`
 * asserts that boundary directly.
 *
 * `resolveMountPath` is the deliberate exception to the policy engine's "no
 * I/O" rule. It has to be: a mount decision taken on a path nobody
 * canonicalized is a decision about a string rather than about a directory,
 * and resolving a symlink is a syscall. It is not on `evaluate()`'s path.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { foldedSegments, isInside, isSegmentPrefix, matchSecret } from "./policy.ts";

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
 * Both spellings of the macOS firmlinked directories are listed on purpose.
 * `realpathSync("/etc")` returns `/private/etc` and `realpathSync("/var")`
 * returns `/private/var` on this machine (verified: darwin 25.5.0, APFS), so
 * canonicalization moves the path to the `/private` spelling and a list that
 * named only `/etc` would match nothing after canonicalizing. The unprefixed
 * spelling stays because canonicalization is allowed to fail (see
 * `canonicalizeAsFarAsPossible`) and the check must still refuse in that case.
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
 * itself, plus `/var/root` as a tree above, refuses what is actually dangerous.
 */
const PROTECTED_EXACT: string[] = ["/", "/Users", "/home", "/var", "/private/var"];

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
