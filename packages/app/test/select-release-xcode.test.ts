import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "select-release-xcode.sh");

function fakeXcode(root: string, name: string, version: string): string {
  const developer = join(root, name, "Contents", "Developer");
  const bin = join(developer, "usr", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "xcodebuild"),
    `#!/bin/sh
printf 'Xcode ${version}\n'
i=0
while [ "$i" -lt 2000 ]; do
  printf 'Build version line %s\n' "$i"
  i=$((i + 1))
done
`,
    { mode: 0o755 },
  );
  return developer;
}

test("release Xcode selection consumes full probe output and chooses the highest version", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-xcodes-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  fakeXcode(root, "Xcode.app", "25.4");
  fakeXcode(root, "Xcode_26.0.1.app", "26.0.1");
  const newest = fakeXcode(root, "Xcode_26.3.app", "26.3");
  writeFileSync(
    join(bin, "xcode-select"),
    `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\n' '${newest}'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    const child = Bun.spawn(["/bin/bash", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OMPD_XCODE_APPLICATIONS_ROOT: root,
        OMPD_REQUIRE_IOS_SDK: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr, stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "release_xcode_ready version=26.3\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("release Xcode selection skips a broken installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-xcodes-"));
  const brokenBin = join(root, "Xcode.app", "Contents", "Developer", "usr", "bin");
  const commandBin = join(root, "bin");
  mkdirSync(brokenBin, { recursive: true });
  mkdirSync(commandBin);
  writeFileSync(join(brokenBin, "xcodebuild"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  const newest = fakeXcode(root, "Xcode_26.3.app", "26.3");
  writeFileSync(
    join(commandBin, "xcode-select"),
    `#!/bin/sh
printf '%s\n' '${newest}'
`,
    { mode: 0o755 },
  );

  try {
    const child = Bun.spawn(["/bin/bash", script], {
      env: {
        ...process.env,
        PATH: `${commandBin}:${process.env.PATH}`,
        OMPD_XCODE_APPLICATIONS_ROOT: root,
        OMPD_REQUIRE_IOS_SDK: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr, stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "release_xcode_ready version=26.3\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release Xcode selection fails closed without a qualifying installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-xcodes-"));
  try {
    const child = Bun.spawn(["/bin/bash", script], {
      env: {
        ...process.env,
        OMPD_XCODE_APPLICATIONS_ROOT: root,
        OMPD_REQUIRE_IOS_SDK: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("No Xcode 26+ installation is available\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release Xcode selection rejects an outdated iOS SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-xcodes-"));
  const commandBin = join(root, "bin");
  mkdirSync(commandBin);
  const selected = fakeXcode(root, "Xcode_26.3.app", "26.3");
  writeFileSync(join(commandBin, "xcode-select"), `#!/bin/sh\nprintf '%s\n' '${selected}'\n`, {
    mode: 0o755,
  });
  writeFileSync(join(commandBin, "xcrun"), "#!/bin/sh\nprintf '25.4\n'\n", { mode: 0o755 });

  try {
    const child = Bun.spawn(["/bin/bash", script], {
      env: {
        ...process.env,
        PATH: `${commandBin}:${process.env.PATH}`,
        OMPD_XCODE_APPLICATIONS_ROOT: root,
        OMPD_REQUIRE_IOS_SDK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Selected Xcode 26.3 has iOS SDK 25.4; iOS SDK 26+ is required\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
