/**
 * Serve `public/` for local verification.
 *
 * Deliberately not a build step: the site is hand-written HTML and CSS with real
 * screenshots, so there is nothing to compile and no bundler to go wrong. What
 * ships is what is in `public/`.
 *
 * Paths are resolved from this file rather than from the working directory, so
 * the server behaves the same whether it is started from the package or the repo
 * root. A relative `./public` would silently serve nothing from the wrong cwd.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "..", "public");
// An explicit loopback bind on an unusual port. Binding the wildcard took IPv6
// only, while a client resolving `127.0.0.1` reached an unrelated dev server that
// already held IPv4 on the same port -- so the verifier happily audited someone
// else's website. Naming the hostname removes the dual-stack ambiguity.
const port = Number(process.env.SITE_PORT ?? 4399);
const hostname = process.env.SITE_HOST ?? "127.0.0.1";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? TYPES[path.slice(dot)] : undefined) ?? "application/octet-stream";
}

Bun.serve({
  port,
  hostname,
  fetch(req) {
    const { pathname } = new URL(req.url);
    // `normalize` collapses any `..` before the prefix check, so a crafted path
    // cannot climb out of `public/`.
    const rel = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
    const full = join(root, rel);
    if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Bun.file(full), { headers: { "content-type": contentType(full) } });
  },
});

console.log(`serving ${root} at http://${hostname}:${port}`);
