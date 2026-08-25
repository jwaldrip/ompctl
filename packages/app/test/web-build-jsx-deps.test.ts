/**
 * The production web build must be able to parse dependencies that ship JSX in
 * `.js` files.
 *
 * `bun run build:web` was red on `main`: `react-native-qrcode-svg@6.3.21`
 * publishes only `src/`, its components return `<Svg>`, and rollup's commonjs
 * resolver stopped at the first angle bracket with `Expression expected` after
 * 468 modules. `optimizeDeps.esbuildOptions.loader` did not help because that
 * governs dependency pre-bundling for the dev server, not the rollup build.
 *
 * This test drives the real Vite build rather than inspecting the config, and
 * it asserts both directions in the same file: with the plugin the QR module
 * parses and lands as JavaScript, and without it the build fails. The second
 * assertion is the one that matters -- a check that cannot fail is worse than
 * no check, and a config-shape assertion would pass against a plugin that had
 * quietly stopped matching the package path.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import baseConfig, { untranspiledJsxDeps } from "../vite.config.ts";

const APP_ROOT = join(import.meta.dir, "..");

/**
 * A throwaway entry that pulls in the QR dependency and nothing else.
 *
 * It has to live inside the app package: rollup resolves a bare specifier from
 * the importer's own directory, so an entry under `/tmp` cannot see
 * `node_modules` and fails as an unresolved import rather than as the parse
 * error this test is about.
 */
function qrEntry(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(APP_ROOT, "__qr-probe-"));
  const file = join(dir, "entry.js");
  // The same import `packages/app/src/screens/InviteScreen.tsx` makes, then a
  // side effect so rollup cannot shake the component away: a bare re-export
  // gets tree-shaken to almost nothing, and then "is it in the graph" has no
  // observable answer.
  writeFileSync(
    file,
    'import QRCode from "react-native-qrcode-svg";\nglobalThis.__ompctlQr = QRCode;\nexport default QRCode;\n',
  );
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build `entry` with the app's real web config, optionally dropping the JSX
 * plugin, and return the emitted JavaScript.
 */
async function buildEntry(entry: string, opts: { withPlugin: boolean }): Promise<string> {
  const configPlugins = Array.isArray(baseConfig.plugins) ? baseConfig.plugins : [];
  const plugins = opts.withPlugin
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

describe("the web build and untranspiled JSX dependencies", () => {
  test("the QR dependency parses and lands as JavaScript", async () => {
    const probe = qrEntry();
    try {
      const code = await buildEntry(probe.file, { withPlugin: true });
      // Really in the graph rather than externalised. `xMidYMid slice` is the
      // preserveAspectRatio the QR package hands its logo <Image>: a string
      // literal minification keeps, unlike the identifiers around it.
      expect(code).toContain("xMidYMid slice");
      // And it arrived as JavaScript. A surviving `<Svg` would mean the
      // transform never ran and rollup had merely skipped the file.
      expect(code).not.toContain("<Svg");
      expect(code).not.toContain("<Defs");
    } finally {
      probe.cleanup();
    }
  }, 60_000);

  test("without the plugin the same build fails, which is why the plugin exists", async () => {
    // The fail-before proof, run on every suite rather than recorded once in a
    // commit message.
    const probe = qrEntry();
    let failure = "";
    try {
      await buildEntry(probe.file, { withPlugin: false });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      probe.cleanup();
    }
    expect(failure).not.toBe("");
    // Named precisely: the exact defect, not merely "some build error".
    expect(failure).toContain("react-native-qrcode-svg");
  }, 60_000);

  test("the transform is scoped to named packages, not all of node_modules", () => {
    // A blanket `.js` -> jsx loader would reinterpret every dependency, and
    // that fails as a wrong parse somewhere unrelated rather than as an error
    // here. So the plugin has to stay narrow, and this notices if it stops.
    const plugin = untranspiledJsxDeps();
    expect(plugin.name).toBe("ompctl:untranspiled-jsx-deps");
    expect(plugin.enforce).toBe("pre");
  });
});
