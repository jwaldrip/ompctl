/**
 * `git clone`, run for a device that is not at the keyboard.
 *
 * Everything unusual here follows from that one fact. The operator cannot
 * answer a credential prompt, so git is told never to ask: an unauthenticated
 * clone must fail in seconds rather than hang forever on a terminal nobody is
 * watching. The operator cannot see a terminal, so progress is forwarded line
 * by line and capped, because a progress hint on a phone is a few lines of
 * reassurance and not a transcript. And the operator may walk into a lift, so
 * a socket that goes away takes its clone with it rather than leaving git
 * running against a directory nobody asked for any more.
 *
 * The url is validated before anything is spawned, and a url carrying
 * userinfo is refused rather than run. That refusal is not about what git
 * would do with it -- git would clone happily -- it is about this daemon
 * keeping an audit record of every clone. A record that named
 * `https://x-access-token:ghp_...@github.com/...` would make the audit log
 * the best place on the machine to harvest a token, so the credential form is
 * refused at the door and never reaches a log line.
 */

import { access } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { CloneId } from "@ompd/core";
import { FsRefusal, type RootSet } from "./roots.ts";

/**
 * Progress lines forwarded per clone. git's `--progress` output is
 * carriage-return driven and chatty; a phone needs to see that something is
 * happening, and 200 lines is already more than anyone reads.
 */
export const MAX_CLONE_LINES = 200;

/** Longest forwarded line. git writes long remote messages; a phone shows a few words of one. */
export const MAX_CLONE_LINE_CHARS = 500;

/** Trailing lines kept for a failure message, so a refusal can say what git said. */
const FAILURE_TAIL_LINES = 5;

/**
 * The slice of a spawned process this module drives, so a test can hand it a
 * child of its own choosing without a real clone. `Bun.spawn`'s subprocess
 * satisfies it as-is.
 */
export interface CloneProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export type CloneSpawn = (
  argv: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => CloneProcess;

export interface CloneRequest {
  url: string;
  /** Directory the clone lands under. Must resolve inside the roots. */
  parent: string;
  /** Directory name to create. Defaults to the repository's own name. */
  name?: string;
}

export interface CloneRun {
  cloneId: CloneId;
  /** Absolute destination. It exists only once `finished` has resolved. */
  path: string;
  /** The url as validated, safe to record: it carries no userinfo. */
  url: string;
  /** Resolves when the clone succeeded, rejects with an `FsRefusal` when it did not. */
  finished: Promise<void>;
  /** Stop the clone. Safe to call twice, and safe to call after it finished. */
  cancel(): void;
}

export interface StartCloneOptions {
  roots: RootSet;
  request: CloneRequest;
  /** Called with each forwarded progress line, already capped and trimmed. */
  onProgress: (line: string) => void;
  spawn?: CloneSpawn;
}

/**
 * Environment for a clone nobody can answer for.
 *
 * `GIT_TERMINAL_PROMPT=0` is the one that matters: without it, a private
 * https clone blocks on a username prompt against a pipe that will never
 * carry one, and the operator sees a clone that simply never finishes. The
 * askpass variables close the graphical version of the same trap.
 */
function cloneEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
  };
}

/**
 * Validate a clone url and answer with the repository name it implies.
 *
 * The rule about userinfo is the interesting part, and it is drawn where a
 * credential can actually ride rather than at the syntax. A password is
 * refused in every form: there is no legitimate `pass@` in a clone url, and
 * `https://x-access-token:ghp_...@github.com/...` is exactly the string that
 * must never reach an audit record. A bare username is refused over http and
 * https, because that is the other half of the same trick -- a token pasted
 * as the username -- and it is refused for `file://`, where a login name
 * means nothing at all.
 *
 * A bare username over ssh (`ssh://git@host/org/repo.git`) and in the
 * scp-like form (`git@host:org/repo.git`) is accepted, because there it is a
 * login name and ssh authenticates by key. Refusing it would not protect a
 * secret -- there is none in the string -- it would simply make cloning a
 * private repository from a phone impossible, which is most of why this
 * feature exists.
 */
export function validateCloneUrl(url: string): { url: string; repo: string } {
  if (typeof url !== "string" || url.trim().length === 0) throw new FsRefusal("bad_url", "a clone url is required");
  const trimmed = url.trim();
  if (/[\0\n\r]/.test(trimmed)) throw new FsRefusal("bad_url", "a clone url may not contain control characters");
  // A leading dash would be read by git as an option rather than a url.
  if (trimmed.startsWith("-")) throw new FsRefusal("bad_url", "a clone url may not begin with a dash");

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    if (!CLONE_SCHEMES[scheme]) {
      throw new FsRefusal("bad_url", `${scheme}:// is not a scheme this daemon clones from`);
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new FsRefusal("bad_url", "that clone url is not a url");
    }
    if (parsed.password.length > 0 || (parsed.username.length > 0 && !SSH_LOGIN_SCHEMES[scheme])) {
      // Never echoed, never logged: the refusal names the shape, not the value.
      throw new FsRefusal("credential_in_url", "that clone url carries a credential; clone without it");
    }
    return { url: trimmed, repo: repoNameFrom(parsed.pathname) };
  }

  const scpLike = /^([^/@]+@)?([^/@:]+):(.+)$/.exec(trimmed);
  if (scpLike) {
    const userinfo = scpLike[1] ?? "";
    if (userinfo.includes(":")) {
      throw new FsRefusal("credential_in_url", "that clone url carries a credential; clone without it");
    }
    return { url: trimmed, repo: repoNameFrom(scpLike[3] ?? "") };
  }

  // A bare path: cloning a repository already on this machine, which is how a
  // local fixture and an operator's own bare mirror both look.
  if (isAbsolute(trimmed)) return { url: trimmed, repo: repoNameFrom(trimmed) };
  throw new FsRefusal("bad_url", "that clone url is neither a url, an scp-like address, nor an absolute path");
}

/** Schemes git can be handed without a credential prompt this daemon cannot answer. */
const CLONE_SCHEMES: Record<string, true> = { https: true, http: true, ssh: true, git: true, file: true };

/**
 * Schemes where a bare username is a login name rather than a credential. ssh
 * authenticates by key and `git://` is anonymous; http and https are where a
 * token gets pasted, and `file://` has no login to name.
 */
const SSH_LOGIN_SCHEMES: Record<string, true> = { ssh: true, git: true };

/** The directory name a clone would create, from the url's own last segment. */
function repoNameFrom(pathname: string): string {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  const decoded = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (decoded.length === 0 || decoded === "." || decoded === "..") {
    throw new FsRefusal("bad_url", "that clone url names no repository");
  }
  return decoded;
}

/** A clone's directory name must be one path segment the operator chose, not a path. */
function validateCloneName(name: string): string {
  if (name.length === 0) throw new FsRefusal("bad_name", "a clone directory name may not be empty");
  if (name === "." || name === "..") throw new FsRefusal("bad_name", `${name} is not a directory name`);
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new FsRefusal("bad_name", "a clone directory name must be a single path segment");
  }
  return name;
}

/**
 * Validate everything, then start git. Refusals are thrown before anything is
 * spawned and before anything is created, so a refused clone leaves the disk
 * exactly as it was.
 */
export async function startClone(options: StartCloneOptions): Promise<CloneRun> {
  const { repo, url } = validateCloneUrl(options.request.url);
  const name = validateCloneName(options.request.name === undefined ? repo : options.request.name.trim());
  const parent = await options.roots.directory(options.request.parent);
  const target = join(parent, name);
  // The join cannot escape a validated single segment, so this is a second
  // proof rather than the only one -- and the cheap kind to keep, because it
  // is the assertion that would catch a future edit loosening the name rule.
  if (!target.startsWith(parent + sep) || target === parent) {
    throw new FsRefusal("bad_name", "that clone destination is not inside the directory it was given");
  }

  let exists = true;
  try {
    await access(target);
  } catch {
    exists = false;
  }
  if (exists) throw new FsRefusal("target_exists", `${target} already exists`);

  const spawn = options.spawn ?? defaultCloneSpawn;
  const child = spawn(["git", "clone", "--progress", "--", url, target], { cwd: parent, env: cloneEnv() });

  const tail: string[] = [];
  let forwarded = 0;
  const forward = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const capped = trimmed.length > MAX_CLONE_LINE_CHARS ? trimmed.slice(0, MAX_CLONE_LINE_CHARS) : trimmed;
    tail.push(capped);
    if (tail.length > FAILURE_TAIL_LINES) tail.shift();
    // Draining continues past the cap; only the forwarding stops. A child
    // whose output nobody reads blocks on a full pipe, which would turn a
    // chatty clone into one that never finishes.
    if (forwarded >= MAX_CLONE_LINES) return;
    forwarded += 1;
    options.onProgress(capped);
  };

  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    try {
      // SIGTERM, not SIGKILL: git installs its own cleanup for it and removes
      // the directory it had started writing, which is what makes a cancelled
      // clone retryable instead of leaving a target that refuses the retry.
      child.kill(15);
    } catch {
      // Already gone. Nothing to stop.
    }
  };

  const finished = (async (): Promise<void> => {
    await Promise.all([drain(child.stdout, forward), drain(child.stderr, forward)]);
    const code = await child.exited;
    if (cancelled) throw new FsRefusal("clone_failed", "the clone was cancelled");
    if (code !== 0) {
      const said = tail.at(-1);
      throw new FsRefusal(
        "clone_failed",
        said === undefined ? `git clone exited ${code}` : `git clone failed: ${said}`,
      );
    }
  })();

  return { cloneId: `cln_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, path: target, url, finished, cancel };
}

const defaultCloneSpawn: CloneSpawn = (argv, options) =>
  Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

/**
 * Read one stream as progress lines.
 *
 * Split on carriage returns as well as newlines, because that is how git
 * writes progress: one line rewritten in place. Treating `\r` as a boundary
 * is what turns "Receiving objects: 47%" into something a phone can show
 * while it happens, rather than one enormous line at the end.
 */
async function drain(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  if (stream === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const parts = buffered.split(/\r\n|\r|\n/);
      buffered = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    }
  } catch {
    // The child went away mid-read, which the exit code below reports. There
    // is nothing a partial line adds to that.
  }
  if (buffered.length > 0) onLine(buffered);
}
