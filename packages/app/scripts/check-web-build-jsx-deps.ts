#!/usr/bin/env bun
/**
 * Exercise the production Vite graph that contains react-native-qrcode-svg.
 *
 * This is deliberately a standalone process. Vite owns a process-global
 * esbuild service; running it in Bun's shared render-test process lets another
 * test tear that service down while a transform is in flight. A subprocess is
 * the production shape and keeps the proof about the build, not test order.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import baseConfig from "../vite.config.ts";

const APP_ROOT = join(import.meta.dirname, "..");

function qrEntry(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(APP_ROOT, "__qr-probe-"));
  const file = join(dir, "entry.js");
  writeFileSync(
    file,
    'import QRCode from "react-native-qrcode-svg";\nglobalThis.__ompctlQr = QRCode;\nexport default QRCode;\n',
  );
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function buildEntry(entry: string, withPlugin: boolean): Promise<string> {
  const configPlugins = Array.isArray(baseConfig.plugins) ? baseConfig.plugins : [];
  const plugins = withPlugin
    ? configPlugins
    : configPlugins.filter(plugin => (plugin as Plugin | null)?.name !== "ompctl:untranspiled-jsx-deps");
  const result = await build({
    ...baseConfig,
    configFile: false,
    root: APP_ROOT,
    logLevel: "silent",
    plugins,
    build: { write: false, sourcemap: false, rollupOptions: { input: entry } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap(out => ("output" in out ? out.output : []));
  return chunks.map(chunk => ("code" in chunk ? chunk.code : "")).join("\n");
}

export async function checkWebBuildJsxDeps(): Promise<void> {
  const withPlugin = qrEntry();
  try {
    const code = await buildEntry(withPlugin.file, true);
    if (!code.includes("xMidYMid slice")) {
      throw new Error("react-native-qrcode-svg was not present in the production output");
    }
    if (code.includes("<Svg") || code.includes("<Defs")) {
      throw new Error("react-native-qrcode-svg reached the production output as JSX");
    }
  } finally {
    withPlugin.cleanup();
  }

  const withoutPlugin = qrEntry();
  try {
    let failure = "";
    try {
      await buildEntry(withoutPlugin.file, false);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!failure.includes("react-native-qrcode-svg")) {
      throw new Error(
        failure === ""
          ? "the production build succeeded without the JSX transform"
          : `the build failed for the wrong reason: ${failure}`,
      );
    }
  } finally {
    withoutPlugin.cleanup();
  }
}

if (import.meta.main) {
  try {
    await checkWebBuildJsxDeps();
    console.log("web JSX dependency gate: clean");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
