import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("the production macOS Metro graph selects only compatible platform modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ompctl-macos-metro-"));
  scratch.push(dir);
  const probePath = join(dir, "probe.mjs");
  const resultPath = join(dir, "graph.json");
  writeFileSync(
    probePath,
    `import { writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const appRoot = ${JSON.stringify(appRoot)};
const repoRoot = path.resolve(appRoot, "..", "..");
const require = createRequire(import.meta.url);
const { buildGraph } = require(path.join(repoRoot, "node_modules", "metro"));
const config = require(path.join(appRoot, "metro.config.cjs"));
const graph = await buildGraph(config, {
  entries: [path.join(appRoot, "index.js")],
  platform: "macos",
  dev: false,
  minify: false,
  type: "module",
});
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify([...graph.dependencies.keys()]));
`,
  );

  const child = Bun.spawn(["node", probePath], {
    cwd: appRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const files = JSON.parse(readFileSync(resultPath, "utf8")) as string[];
  const normalized = files.map(file => file.replaceAll("\\\\", "/"));

  expect(normalized.some(file => file.endsWith("react-native-macos/Libraries/Utilities/Platform.macos.js"))).toBe(true);
  expect(normalized.some(file => file.includes("/node_modules/react-native/Libraries/Utilities/Platform"))).toBe(false);
  expect(normalized.some(file => file.endsWith("/src/platform/camera.macos.ts"))).toBe(true);
  expect(normalized.some(file => file.endsWith("/src/platform/camera.ts"))).toBe(false);
  expect(normalized.some(file => file.includes("react-native-vision-camera"))).toBe(false);
  expect(normalized.some(file => file.endsWith("/views/NativeStackView.js"))).toBe(true);
  expect(normalized.some(file => file.includes("/views/NativeStackView.native"))).toBe(false);
}, 120_000);
