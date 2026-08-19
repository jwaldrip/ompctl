/**
 * One page of one directory, for a phone.
 *
 * Two properties matter more than anything else here, and both come from the
 * screen this feeds rather than from the filesystem. The first is that the
 * answer is bounded: a directory can hold fifty thousand entries, and an
 * operator standing up with a phone needs the first screenful now, not the
 * whole tree eventually. The second is that the answer is cheap: a dirent
 * already says whether an entry is a directory, so nothing here stats an
 * entry to learn its kind, and the one stat this does spend -- looking for
 * `.git` -- is spent only on the directories that made the page, because that
 * marking is the thing the operator is actually scanning for.
 *
 * Ordering is a product decision, not an artifact of readdir: directories
 * first, then visible before hidden, then by name. On a phone the first
 * screenful has to be the directories someone is looking for, and a listing
 * that opens with forty dot-directories is one someone has to scroll past
 * every single time.
 */

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FsEntry, FsEntryKind, FsListing } from "@ompd/core";
import type { RootSet } from "./roots.ts";

/**
 * Entries carried by one listing.
 *
 * Sized for a scroll rather than for a filesystem: 500 rows is already far
 * more than anyone reads on a phone, and a client is told when there are
 * more, so the bound never masquerades as the whole directory.
 */
export const MAX_FS_ENTRIES = 500;

interface Candidate {
  name: string;
  kind: FsEntryKind;
}

/**
 * List a directory inside the roots, or the roots themselves when no path is
 * given. Refusals come from `RootSet` and carry its codes.
 */
export async function listDirectory(roots: RootSet, path: string | undefined): Promise<FsListing> {
  const available = await roots.requireRoots();
  if (path === undefined) {
    // The roots listing. Each entry names an absolute root, because a bare
    // basename would be ambiguous across two roots and there is no
    // containing directory to join it onto.
    const entries: FsEntry[] = [];
    for (const root of available) entries.push(await describeDirectory(root, root));
    return { path: "", parent: null, roots: available, entries, bounded: false };
  }

  const real = await roots.directory(path);
  const dirents = await readdir(real, { withFileTypes: true });
  const candidates: Candidate[] = dirents.map(dirent => ({
    name: dirent.name,
    // Symlinks are tested first and never followed here: readdir reports a
    // link to a directory as a link, and resolving it is the job of the
    // request that opens it, where the roots boundary gets to refuse a link
    // that points out of them.
    kind: dirent.isSymbolicLink() ? "link" : dirent.isDirectory() ? "dir" : "file",
  }));
  candidates.sort(byUsefulness);

  const page = candidates.slice(0, MAX_FS_ENTRIES);
  const entries = await Promise.all(
    page.map(async candidate =>
      candidate.kind === "dir"
        ? await describeDirectory(join(real, candidate.name), candidate.name)
        : { name: candidate.name, kind: candidate.kind },
    ),
  );

  return {
    path: real,
    parent: roots.parentOf(real, available),
    roots: available,
    entries,
    bounded: candidates.length > page.length,
  };
}

/**
 * A directory entry, marked when it is the top of a git working tree.
 *
 * `.git` is tested for existence rather than for being a directory: a linked
 * worktree's `.git` is a file, and a worktree is exactly as much a place to
 * start work as the checkout it was cut from. A daemon that only recognised
 * the directory form would leave every worktree on this machine unmarked.
 */
async function describeDirectory(fullPath: string, name: string): Promise<FsEntry> {
  try {
    await access(join(fullPath, ".git"));
    return { name, kind: "dir", gitRepo: true };
  } catch {
    return { name, kind: "dir" };
  }
}

/** Directories first, visible before hidden, then by name, case last. */
function byUsefulness(left: Candidate, right: Candidate): number {
  const leftDir = left.kind === "dir" ? 0 : 1;
  const rightDir = right.kind === "dir" ? 0 : 1;
  if (leftDir !== rightDir) return leftDir - rightDir;

  const leftHidden = left.name.startsWith(".") ? 1 : 0;
  const rightHidden = right.name.startsWith(".") ? 1 : 0;
  if (leftHidden !== rightHidden) return leftHidden - rightHidden;

  // Deliberately not `localeCompare`: the order must be identical on every
  // machine a test runs on, and a locale-aware collation is not.
  const leftKey = left.name.toLowerCase();
  const rightKey = right.name.toLowerCase();
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
