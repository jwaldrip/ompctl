/**
 * The one object the gateway holds for browsing this machine and starting work
 * on it.
 *
 * It exists so the gateway never sees a root, a realpath, or a subprocess: it
 * asks for a listing, a verified directory, or a clone, and gets an answer or
 * an `FsRefusal` carrying the code to put on the wire. That keeps the boundary
 * decision -- which is the security property this whole feature rests on -- in
 * `roots.ts` and in exactly one place, rather than spread across three frame
 * handlers that each have to remember it.
 *
 * Absent from a daemon build, the three frames report the feature off. That is
 * deliberate and it is the safe direction: an unconfigured daemon browses
 * nothing, and "no roots" must never quietly mean "the whole filesystem".
 */

import type { FsListing } from "@ompd/core";
import { listDirectory } from "./browse.ts";
import { type CloneRequest, type CloneRun, type CloneSpawn, startClone } from "./clone.ts";
import { RootSet } from "./roots.ts";

export { MAX_FS_ENTRIES } from "./browse.ts";
export type { CloneProcess, CloneRequest, CloneRun, CloneSpawn } from "./clone.ts";
export { MAX_CLONE_LINE_CHARS, MAX_CLONE_LINES, validateCloneUrl } from "./clone.ts";
export { FsRefusal, type FsRefusalCode, RootSet } from "./roots.ts";

export interface FilesystemOptions {
  /**
   * Directories a device may browse, start a session in, and clone into.
   * Absolute paths; one that does not exist is skipped rather than fatal.
   */
  roots: readonly string[];
  /** Process seam, so a test drives a clone without a real `git clone`. */
  spawn?: CloneSpawn;
}

/**
 * What the gateway needs, declared as an interface so the frame handlers can
 * be read without this file: the same shape `SkillCatalog` and `RoutineRunner`
 * take there.
 */
export interface FilesystemSurface {
  /** One page of a directory, or the roots when no path is given. */
  list(path: string | undefined): Promise<FsListing>;
  /** An existing directory inside the roots, resolved, for an agent's cwd. */
  directory(path: string): Promise<string>;
  /** Start a clone. Refuses before spawning, so a refusal creates nothing. */
  clone(request: CloneRequest, onProgress: (line: string) => void): Promise<CloneRun>;
}

export class Filesystem implements FilesystemSurface {
  readonly #roots: RootSet;
  readonly #spawn: CloneSpawn | undefined;

  constructor(options: FilesystemOptions) {
    this.#roots = new RootSet(options.roots);
    this.#spawn = options.spawn;
  }

  async list(path: string | undefined): Promise<FsListing> {
    return await listDirectory(this.#roots, path);
  }

  async directory(path: string): Promise<string> {
    return await this.#roots.directory(path);
  }

  async clone(request: CloneRequest, onProgress: (line: string) => void): Promise<CloneRun> {
    return await startClone({
      roots: this.#roots,
      request,
      onProgress,
      ...(this.#spawn === undefined ? {} : { spawn: this.#spawn }),
    });
  }
}
