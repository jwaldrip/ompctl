/**
 * Serve the built marketing site on Cloud Run.
 *
 * Separate from `scripts/serve.ts`, which exists for local verification and
 * binds loopback on a fixed port. This one binds the wildcard on `PORT` because
 * Cloud Run health checks arrive on the container's own address, and it serves
 * `dist/` only: the image is built from a `bun run build` that already refused
 * to produce a `dist/` with a missing asset or a dead anchor, so falling back to
 * `public/` here would let an unverified tree ship.
 *
 * This is the apex host. It deliberately does NOT serve
 * `/.well-known/apple-app-site-association` or `assetlinks.json` -- those
 * belong to `app.ompctl.ai` (the `ompctl-web` service). Serving them from two
 * origins would leave two copies to drift.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 8080);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? TYPES[path.slice(dot)] : undefined) ?? "application/octet-stream";
}

/** Screenshots are content-addressed by name and never rewritten in place. */
function cacheControl(rel: string): string {
  return rel.startsWith("shots/") ? "public, max-age=86400" : "public, max-age=300";
}

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/healthz" || pathname === "/v1/health") {
      return Response.json({ ok: true, service: "ompctl-site" });
    }

    // `normalize` collapses `..` before the prefix check, so a crafted path
    // cannot climb out of the served root.
    const rel = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
    const full = join(root, rel);
    if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(readFileSync(full), {
      headers: { "content-type": contentType(full), "cache-control": cacheControl(rel) },
    });
  },
});

console.log(JSON.stringify({ severity: "INFO", message: "ompctl site listening", port, root }));
