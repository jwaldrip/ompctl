import { expect, test } from "bun:test";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");

test("Vite extension resolution picks camera.web.ts over camera.ts", async () => {
  const probe = `
    const { createServer } = await import("vite");
    const { default: config } = await import("./vite.config.ts");
    const server = await createServer({
      ...config,
      root: process.cwd(),
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true },
    });
    try {
      const resolved = await server.pluginContainer.resolveId("./src/platform/camera", undefined, { isEntry: true });
      if (!resolved?.id.endsWith("camera.web.ts")) process.exitCode = 1;
    } finally {
      await server.close();
    }
  `;
  const script = probe.replace(/\s*\n\s*/g, " ");
  const child = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
    cwd: appRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = child.stderr.toString();

  expect({ exitCode: child.exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
});
