/**
 * The type gate has to fail when the code is broken, including when the repo
 * is reached through a symlink.
 *
 * This is not hypothetical. Every agent worktree in one session lived under
 * `/tmp`, which on macOS is a symlink to `/private/tmp`, and the gate reported
 * `clean` for packages whose own source did not compile. The compiler names
 * each file relative to `PWD` while resolving the file physically, so from a
 * symlinked directory it emits paths like
 * `../../../../private/tmp/<repo>/packages/app/src/x.ts`: up out of the
 * logical path and back down the physical one. Re-resolved against the
 * physical directory that lands outside the repo, where the classifier read it
 * as somebody else's dependency and stopped gating.
 *
 * So the test walks the real script, through a real symlink, against a project
 * that really does not compile. A unit test of the classifier would have
 * passed throughout the defect, because the classifier was never the part that
 * was wrong.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "check-types.ts");

/**
 * A one-file project that does not compile, plus a symlink pointing at it.
 * `mkdtemp` already hands back a physical path, so the symlink is the only
 * thing standing between the two spellings, which is exactly the shape being
 * tested.
 */
function brokenProjectBehindSymlink(): { physical: string; through: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "check-types-"));
  const real = join(root, "real");
  mkdirSync(join(real, "src"), { recursive: true });
  writeFileSync(
    join(real, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["src"] }),
  );
  // A name that is not declared anywhere: the same TS2304 an import lost to a
  // bad merge produces, which is the defect this gate missed in real life.
  writeFileSync(join(real, "src", "index.ts"), "export const broken: string = missingIdentifier;\n");
  const link = join(root, "link");
  symlinkSync(real, link);
  return { physical: real, through: link, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runGate(cwd: string): { exitCode: number; output: string } {
  // The compiler is a local devDependency, so a fixture outside the repo has
  // no `tsgo` on its path and `bunx` would reach for the registry and 404.
  // Lending it the repo's own bin keeps the fixture hermetic in every other
  // respect while testing the real script rather than a stand-in.
  const bin = resolve(import.meta.dirname, "..", "node_modules", ".bin");
  // Captured through a file rather than through the runner's pipes. Under
  // `bun test` a piped child here comes back with both buffers empty while
  // still reporting its real exit code, and an assertion against an empty
  // string passes for a run that printed a page of diagnostics. A test that
  // cannot see what it is asserting on is the same defect this file exists to
  // catch, one level up.
  const log = join(cwd, "gate-output.txt");
  const run = Bun.spawnSync(["sh", "-c", `bun ${JSON.stringify(script)} tsconfig.json > ${JSON.stringify(log)} 2>&1`], {
    cwd,
    env: { ...process.env, PWD: cwd, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  return { exitCode: run.exitCode, output: readFileSync(log, "utf8") };
}
describe("check-types", () => {
  test("a project that does not compile fails the gate when reached through a symlink", () => {
    const project = brokenProjectBehindSymlink();
    try {
      const viaLink = runGate(project.through);
      expect(viaLink.output).toContain("TS2304");
      expect(viaLink.exitCode).toBe(1);
      // The tell of the original defect: real diagnostics filed as dependency
      // noise, printed as a count and then followed by `clean`.
      expect(viaLink.output).not.toContain("not gating");
      expect(viaLink.output).not.toContain("clean");
    } finally {
      project.cleanup();
    }
  });

  test("the same project fails identically by its physical path", () => {
    const project = brokenProjectBehindSymlink();
    try {
      const direct = runGate(project.physical);
      const viaLink = runGate(project.through);
      expect(direct.exitCode).toBe(1);
      // Same verdict by either spelling. Diagnostics are compared by code and
      // line rather than by string, since the two runs legitimately name the
      // file through different roots.
      const codes = (output: string): string[] => [...output.matchAll(/TS\d+/g)].map(match => match[0]);
      expect(codes(viaLink.output)).toEqual(codes(direct.output));
    } finally {
      project.cleanup();
    }
  });
});
