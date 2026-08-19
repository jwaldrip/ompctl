/**
 * The boundary a remote device's browsing runs into, and the clone that runs
 * behind it.
 *
 * Every test here is about a real directory on a real disk, because the thing
 * under test is a decision about the filesystem and a fake filesystem would
 * prove a decision about the fake. The temp directories are realpath'd on the
 * way in for the same reason the production code realpaths its roots: on macOS
 * `/var` is a symlink, so a test comparing unresolved paths would be asserting
 * against a path the kernel does not use.
 *
 * The clone tests use a local fixture repository and never the network. A test
 * that needed github to pass is a test that fails on a train.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Filesystem,
  FsRefusal,
  type FsRefusalCode,
  MAX_CLONE_LINES,
  MAX_FS_ENTRIES,
  validateCloneUrl,
} from "../src/filesystem/index.ts";

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** The refusal code a call produced, or the fact that it produced none. */
async function refusalOf(run: () => Promise<unknown>): Promise<FsRefusalCode | "no refusal"> {
  try {
    await run();
    return "no refusal";
  } catch (err) {
    if (err instanceof FsRefusal) return err.code;
    throw err;
  }
}

/** A git repository with one commit, as a clone source that needs no network. */
async function fixtureRepo(): Promise<string> {
  const dir = tempDir("fs-fixture-repo-");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  const git = async (...args: string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  };
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=fixture@ompd.test", "-c", "user.name=Fixture", "add", "README.md");
  await git("-c", "user.email=fixture@ompd.test", "-c", "user.name=Fixture", "commit", "-q", "-m", "first");
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

describe("listing a directory", () => {
  test("answers the roots when no path is given, each named absolutely", async () => {
    const first = tempDir("fs-root-a-");
    const second = tempDir("fs-root-b-");
    const fs = new Filesystem({ roots: [first, second] });

    const listing = await fs.list(undefined);

    expect(listing.path).toBe("");
    expect(listing.parent).toBeNull();
    expect(listing.roots).toEqual([first, second]);
    expect(listing.entries.map(entry => entry.name)).toEqual([first, second]);
    expect(listing.bounded).toBe(false);
  });

  test("lists a root's own entries, with nothing above it to walk up to", async () => {
    const root = tempDir("fs-root-");
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "notes.txt"), "hello\n");
    const fs = new Filesystem({ roots: [root] });

    const listing = await fs.list(root);

    expect(listing.path).toBe(root);
    // The directory above a root belongs to no root, so there is nothing a
    // device may walk up to from here.
    expect(listing.parent).toBeNull();
    expect(listing.entries).toEqual([
      { name: "alpha", kind: "dir" },
      { name: "notes.txt", kind: "file" },
    ]);
  });

  test("offers the parent of a directory inside a root", async () => {
    const root = tempDir("fs-root-");
    const child = join(root, "work", "deep");
    mkdirSync(child, { recursive: true });
    const fs = new Filesystem({ roots: [root] });

    expect((await fs.list(child)).parent).toBe(join(root, "work"));
  });

  test("marks a checkout and a linked worktree as git working trees", async () => {
    const root = tempDir("fs-root-");
    // A checkout carries a `.git` directory; a linked worktree carries a `.git`
    // file pointing back at the checkout. Both are places to start work.
    mkdirSync(join(root, "checkout", ".git"), { recursive: true });
    mkdirSync(join(root, "worktree"));
    writeFileSync(join(root, "worktree", ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    mkdirSync(join(root, "plain"));
    const fs = new Filesystem({ roots: [root] });

    const listing = await fs.list(root);

    expect(listing.entries).toEqual([
      { name: "checkout", kind: "dir", gitRepo: true },
      { name: "plain", kind: "dir" },
      { name: "worktree", kind: "dir", gitRepo: true },
    ]);
  });

  test("bounds a huge directory and says that it did", async () => {
    const root = tempDir("fs-root-");
    const total = MAX_FS_ENTRIES + 120;
    for (let index = 0; index < total; index += 1) {
      writeFileSync(join(root, `entry-${String(index).padStart(5, "0")}.txt`), "x");
    }
    const fs = new Filesystem({ roots: [root] });

    const listing = await fs.list(root);

    expect(listing.entries).toHaveLength(MAX_FS_ENTRIES);
    expect(listing.bounded).toBe(true);
    // The page is the front of a deterministic order, not an arbitrary slice.
    expect(listing.entries[0]?.name).toBe("entry-00000.txt");
  });

  test("orders directories first, visible before hidden, then by name", async () => {
    const root = tempDir("fs-root-");
    mkdirSync(join(root, ".cache"));
    mkdirSync(join(root, "Zed"));
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, ".env"), "x");
    writeFileSync(join(root, "readme.md"), "x");
    const fs = new Filesystem({ roots: [root] });

    expect((await fs.list(root)).entries.map(entry => entry.name)).toEqual([
      "alpha",
      "Zed",
      ".cache",
      "readme.md",
      ".env",
    ]);
  });

  test("reports a symlink as a link and does not follow it while listing", async () => {
    const root = tempDir("fs-root-");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "pointer"));
    const fs = new Filesystem({ roots: [root] });

    const listing = await fs.list(root);

    expect(listing.entries).toEqual([
      { name: "real", kind: "dir" },
      { name: "pointer", kind: "link" },
    ]);
  });
});

describe("the roots boundary", () => {
  test("refuses a path outside every root", async () => {
    const root = tempDir("fs-root-");
    const outside = tempDir("fs-outside-");
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.list(outside))).toBe("out_of_roots");
    expect(await refusalOf(() => fs.directory(outside))).toBe("out_of_roots");
  });

  test("refuses a traversal that climbs out of a root", async () => {
    const root = tempDir("fs-root-");
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.list(join(root, "..")))).toBe("out_of_roots");
  });

  test("refuses a symlink inside a root that points outside it", async () => {
    const root = tempDir("fs-root-");
    const outside = tempDir("fs-outside-");
    mkdirSync(join(outside, "secrets"));
    symlinkSync(join(outside, "secrets"), join(root, "escape"));
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.list(join(root, "escape")))).toBe("out_of_roots");
  });

  test("refuses a sibling directory whose name merely starts with a root's", async () => {
    // Root `/tmp/x/jo` must not admit `/tmp/x/jones`: the prefix test only
    // holds because it compares against the root plus a separator.
    const parent = tempDir("fs-siblings-");
    const root = join(parent, "jo");
    const sibling = join(parent, "jones");
    mkdirSync(root);
    mkdirSync(sibling);
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.list(sibling))).toBe("out_of_roots");
  });

  test("refuses a relative path, a missing path, and a file", async () => {
    const root = tempDir("fs-root-");
    writeFileSync(join(root, "file.txt"), "x");
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.list("work/deep"))).toBe("bad_path");
    expect(await refusalOf(() => fs.list(join(root, "nope")))).toBe("not_found");
    expect(await refusalOf(() => fs.list(join(root, "file.txt")))).toBe("not_a_directory");
  });

  test("refuses everything when configuration names no directory that exists", async () => {
    const fs = new Filesystem({ roots: [join(tempDir("fs-gone-"), "missing")] });

    expect(await refusalOf(() => fs.list(undefined))).toBe("no_roots");
  });
});

// ---------------------------------------------------------------------------
// Clone urls
// ---------------------------------------------------------------------------

describe("validating a clone url", () => {
  test("accepts the forms an operator actually types, and names the repository", () => {
    expect(validateCloneUrl("https://github.com/jwaldrip/ompctl.git").repo).toBe("ompctl");
    expect(validateCloneUrl("https://github.com/jwaldrip/ompctl").repo).toBe("ompctl");
    // scp-like ssh: a login name, no secret, and the only way to clone a
    // private repository from a phone.
    expect(validateCloneUrl("git@github.com:jwaldrip/ompctl.git").repo).toBe("ompctl");
    expect(validateCloneUrl("ssh://git@github.com/jwaldrip/ompctl.git").repo).toBe("ompctl");
    expect(validateCloneUrl("/srv/mirrors/ompctl.git").repo).toBe("ompctl");
  });

  test("refuses a url carrying a credential, in every form one can wear", () => {
    const codes = [
      "https://x-access-token:ghp_deadbeefdeadbeefdeadbeef@github.com/jwaldrip/ompctl.git",
      // A bare username over https is the same trick with the colon removed.
      "https://ghp_deadbeefdeadbeefdeadbeef@github.com/jwaldrip/ompctl.git",
      "http://ghp_deadbeefdeadbeefdeadbeef@example.com/repo.git",
      // A password is refused even where a username is a login name.
      "ssh://git:hunter2@github.com/jwaldrip/ompctl.git",
      "git:secret@github.com:jwaldrip/ompctl.git",
      // `file://` has no login to name, and WHATWG parsing rejects the
      // authority outright, so it is refused as a url rather than as a
      // credential. Either refusal keeps it away from git and away from a log.
      "file://someone@/srv/mirrors/ompctl.git",
    ].map(url => {
      try {
        validateCloneUrl(url);
        return "no refusal";
      } catch (err) {
        return err instanceof FsRefusal ? err.code : "wrong error";
      }
    });

    expect(codes).toEqual([
      "credential_in_url",
      "credential_in_url",
      "credential_in_url",
      "credential_in_url",
      "credential_in_url",
      "bad_url",
    ]);
  });

  test("never puts the refused url in the message it throws", () => {
    const token = "ghp_deadbeefdeadbeefdeadbeef";
    try {
      validateCloneUrl(`https://x-access-token:${token}@github.com/jwaldrip/ompctl.git`);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(FsRefusal);
      expect((err as FsRefusal).message).not.toContain(token);
    }
  });

  test("refuses a scheme git cannot be handed here, and an option masquerading as a url", () => {
    const codes = ["ftp://example.com/repo.git", "--upload-pack=touch /tmp/pwned", "not a url at all"].map(url => {
      try {
        validateCloneUrl(url);
        return "no refusal";
      } catch (err) {
        return err instanceof FsRefusal ? err.code : "wrong error";
      }
    });

    expect(codes).toEqual(["bad_url", "bad_url", "bad_url"]);
  });
});

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

describe("cloning", () => {
  test("clones a local fixture, streams progress, and lands a working tree", async () => {
    const source = await fixtureRepo();
    const root = tempDir("fs-clone-root-");
    const fs = new Filesystem({ roots: [root] });
    const lines: string[] = [];

    const run = await fs.clone({ url: source, parent: root }, line => lines.push(line));
    await run.finished;

    expect(run.path).toBe(join(root, source.split("/").pop() ?? ""));
    expect(lines.length).toBeGreaterThan(0);
    expect(await Bun.file(join(run.path, "README.md")).text()).toBe("fixture\n");
  });

  test("uses the name it was given rather than the url's", async () => {
    const source = await fixtureRepo();
    const root = tempDir("fs-clone-root-");
    const fs = new Filesystem({ roots: [root] });

    const run = await fs.clone({ url: source, parent: root, name: "chosen" }, () => {});
    await run.finished;

    expect(run.path).toBe(join(root, "chosen"));
    expect(await Bun.file(join(run.path, "README.md")).exists()).toBe(true);
  });

  test("refuses a destination that already exists, and leaves it untouched", async () => {
    const source = await fixtureRepo();
    const root = tempDir("fs-clone-root-");
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "taken", "keep.txt"), "mine\n");
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.clone({ url: source, parent: root, name: "taken" }, () => {}))).toBe(
      "target_exists",
    );
    expect(await Bun.file(join(root, "taken", "keep.txt")).text()).toBe("mine\n");
  });

  test("refuses a name that is a path, and creates nothing", async () => {
    const source = await fixtureRepo();
    const root = tempDir("fs-clone-root-");
    const fs = new Filesystem({ roots: [root] });

    for (const name of ["../escape", "nested/deep", ".."]) {
      expect(await refusalOf(() => fs.clone({ url: source, parent: root, name }, () => {}))).toBe("bad_name");
    }
    expect((await fs.list(root)).entries).toEqual([]);
  });

  test("refuses a parent outside the roots, and creates nothing", async () => {
    const source = await fixtureRepo();
    const root = tempDir("fs-clone-root-");
    const outside = tempDir("fs-clone-outside-");
    const fs = new Filesystem({ roots: [root] });

    expect(await refusalOf(() => fs.clone({ url: source, parent: outside, name: "here" }, () => {}))).toBe(
      "out_of_roots",
    );
    expect(await Bun.file(join(outside, "here", "README.md")).exists()).toBe(false);
  });

  test("reports git's own failure rather than a bare exit code", async () => {
    const root = tempDir("fs-clone-root-");
    const missing = join(root, "not-a-repo");
    mkdirSync(missing);
    const fs = new Filesystem({ roots: [root] });

    const run = await fs.clone({ url: missing, parent: root, name: "attempt" }, () => {});
    let message = "";
    try {
      await run.finished;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("git clone failed");
  });

  test("caps forwarded progress while still draining the child", async () => {
    const root = tempDir("fs-clone-root-");
    const chatty = MAX_CLONE_LINES + 250;
    const fs = new Filesystem({
      roots: [root],
      // A child that talks far more than git does, to prove the cap forwards a
      // bounded number of lines and still lets the process finish rather than
      // wedging on a pipe nobody is reading.
      spawn: () =>
        Bun.spawn(["bun", "-e", `for (let i = 0; i < ${chatty}; i++) console.error("line " + i);`], {
          stdout: "pipe",
          stderr: "pipe",
        }),
    });
    const lines: string[] = [];

    const run = await fs.clone({ url: "https://example.com/repo.git", parent: root }, line => lines.push(line));
    await run.finished;

    expect(lines).toHaveLength(MAX_CLONE_LINES);
    expect(lines[0]).toBe("line 0");
  });

  test("cancelling stops the child", async () => {
    const root = tempDir("fs-clone-root-");
    const fs = new Filesystem({
      roots: [root],
      spawn: () =>
        Bun.spawn(["bun", "-e", 'console.error("started"); setInterval(() => {}, 1000);'], {
          stdout: "pipe",
          stderr: "pipe",
        }),
    });
    const started = Promise.withResolvers<void>();

    const run = await fs.clone({ url: "https://example.com/repo.git", parent: root }, () => started.resolve());
    await started.promise;
    run.cancel();

    // The clone reports the cancellation rather than a success, and the promise
    // settles at all, which is what proves the child is gone: an unkilled
    // `setInterval` child would keep the stream open forever.
    expect(await refusalOf(() => run.finished)).toBe("clone_failed");
  });
});
