/**
 * Which directories a remote device may see, and the single decision every
 * path in this feature passes through.
 *
 * A phone holding `manage` can start a session, and a session runs code. So
 * the honest way to read this file is as the answer to "which parts of the
 * operator's disk does the phone get to name at all", and the answer is: the
 * configured roots, and nothing that resolves outside them.
 *
 * Resolution happens before the comparison, never after. A path is realpath'd
 * first and the result is what gets tested, which is what makes `../../..` and
 * a symlink pointing at `/` the same refusal rather than two separate holes
 * to remember. The roots themselves are realpath'd for the same reason: on
 * macOS `/tmp` and `/var` are symlinks, so a prefix test against the
 * unresolved form would refuse paths that are genuinely inside a root.
 */

import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";

/**
 * Why a path was refused. These are the wire codes: an operator reading a
 * refusal on a phone gets to know which door closed, because "no" without a
 * reason is what makes someone assume the feature is broken and retry.
 */
export type FsRefusalCode =
  /** Configuration names no directory that exists, so there is nothing to browse. */
  | "no_roots"
  /** The path resolves outside every configured root, by traversal or through a symlink. */
  | "out_of_roots"
  /** Nothing is at that path. */
  | "not_found"
  /** Something is there, but it is not a directory. */
  | "not_a_directory"
  /** The path itself is unusable: empty, relative, or carrying a NUL. */
  | "bad_path"
  /** A clone's directory name is not a single path segment. */
  | "bad_name"
  /** The clone url is not one git could be handed. */
  | "bad_url"
  /** The clone url carries userinfo, which is where a token would be. */
  | "credential_in_url"
  /** The clone destination already exists; a clone never writes into one. */
  | "target_exists"
  /** This socket already has as many clones in flight as it may. */
  | "clone_busy"
  /** git ran and failed. */
  | "clone_failed";

/**
 * A refusal with a wire code, in the shape the gateway already uses for
 * `TakeoverRefusal`: the code is the contract, the message is for a person.
 */
export class FsRefusal extends Error {
  readonly code: FsRefusalCode;

  constructor(code: FsRefusalCode, message: string) {
    super(message);
    this.name = "FsRefusal";
    this.code = code;
  }
}

/**
 * Whether `real` is a root or lives under one. Both sides must already be
 * resolved, because this is a string test and a string test on unresolved
 * paths proves nothing.
 *
 * The separator is the whole reason this is a named predicate rather than a
 * `startsWith` at each site: with root `/Users/jo`, the path `/Users/jones`
 * shares the prefix and is a different person's home. Comparing against
 * `root + sep` is what makes a sibling directory a refusal instead of a
 * silent grant, and both callers must make that comparison identically.
 */
function inside(roots: readonly string[], real: string): boolean {
  return roots.some(root => real === root || real.startsWith(root + sep));
}

export class RootSet {
  readonly #configured: readonly string[];

  constructor(roots: readonly string[]) {
    this.#configured = roots;
  }

  /**
   * The roots as they exist right now, resolved and deduplicated.
   *
   * Recomputed per call rather than cached at construction: a root can be an
   * external volume or a directory the operator has not made yet, and a
   * daemon that cached "does not exist" at boot would keep refusing a
   * directory that is plainly there. Three realpath calls per request is not
   * a cost worth a staleness bug.
   */
  async resolved(): Promise<string[]> {
    const seen = new Set<string>();
    for (const candidate of this.#configured) {
      if (typeof candidate !== "string" || candidate.length === 0 || !isAbsolute(candidate)) continue;
      try {
        const real = await realpath(candidate);
        const info = await stat(real);
        if (info.isDirectory()) seen.add(real);
      } catch {
        // A root that is missing, unreadable, or not a directory is not a
        // root. Skipped rather than thrown: one bad entry must not take the
        // whole feature down, and an empty result is already reported as
        // `no_roots` by the callers below.
      }
    }
    return [...seen];
  }

  /**
   * Resolve an existing directory inside the roots, or refuse.
   *
   * The returned path is the resolved one, so everything downstream -- the
   * listing, the agent's cwd, a clone's parent -- operates on the path the
   * kernel agrees with rather than the one the client typed.
   */
  async directory(path: string): Promise<string> {
    const roots = await this.requireRoots();
    const real = await this.resolveInside(path, roots);
    const info = await stat(real);
    if (!info.isDirectory()) throw new FsRefusal("not_a_directory", `${path} is not a directory`);
    return real;
  }

  /**
   * The directory above `real`, when a device may see it.
   *
   * Null at the top of a root, and null for a path whose parent belongs to no
   * root: with nested roots configured the directory above one root can
   * legitimately be inside another, and this reports that rather than
   * pretending the walk has to stop at whichever root was named first.
   */
  parentOf(real: string, roots: readonly string[]): string | null {
    const up = dirname(real);
    if (up === real) return null;
    return inside(roots, up) ? up : null;
  }

  /** The roots, or a refusal naming the fact that configuration offers none. */
  async requireRoots(): Promise<string[]> {
    const roots = await this.resolved();
    if (roots.length === 0) {
      throw new FsRefusal("no_roots", "this daemon's configuration names no browsable directory");
    }
    return roots;
  }

  /**
   * Resolve a path that must exist, and prove it lands inside the roots.
   *
   * `realpath` is what makes this a boundary rather than a string check: it
   * fully resolves `..` segments and every symlink on the way, so the value
   * compared against the roots is where the path actually goes.
   */
  async resolveInside(path: string, roots: readonly string[]): Promise<string> {
    if (typeof path !== "string" || path.length === 0) throw new FsRefusal("bad_path", "a path is required");
    if (path.includes("\0")) throw new FsRefusal("bad_path", "a path may not contain a NUL");
    if (!isAbsolute(path)) throw new FsRefusal("bad_path", `${path} is not an absolute path`);

    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new FsRefusal("not_found", `${path} does not exist`);
    }
    if (!inside(roots, real)) {
      // Deliberately does not echo where it resolved to. The refusal is the
      // useful half; naming the outside target would make this the one place
      // that reports paths from beyond the boundary it exists to hold.
      throw new FsRefusal("out_of_roots", `${path} resolves outside this daemon's browsable directories`);
    }
    return real;
  }
}
