#!/usr/bin/env node
/**
 * Resolve the real production entry through Metro's macOS graph.
 *
 * This runs sequentially under `bun run check`, not inside the concurrent Bun
 * test process. Metro starts worker processes while building the graph; running
 * it beside tests that also exercise subprocess pipes made those tests observe
 * empty stdout and stderr instead of their child results.
 */
import { createRequire } from "node:module";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
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
const files = [...graph.dependencies.keys()].map(file => file.replaceAll("\\", "/"));

const required = [
  "react-native-macos/Libraries/Utilities/Platform.macos.js",
  "/src/platform/camera.macos.ts",
  "/views/NativeStackView.js",
];
const forbidden = [
  "/node_modules/react-native/Libraries/Utilities/Platform",
  "/src/platform/camera.ts",
  "react-native-vision-camera",
  "/views/NativeStackView.native",
];
const missing = required.filter(fragment => !files.some(file => file.endsWith(fragment)));
const present = forbidden.filter(fragment => files.some(file => file.includes(fragment)));

if (missing.length > 0 || present.length > 0) {
  if (missing.length > 0) console.error(`macOS Metro graph is missing: ${missing.join(", ")}`);
  if (present.length > 0) console.error(`macOS Metro graph contains incompatible modules: ${present.join(", ")}`);
  process.exit(1);
}

console.log("OK: macOS Metro graph selects React Native macOS, the camera refusal seam, and JavaScript navigation.");
