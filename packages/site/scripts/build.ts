/**
 * Assemble `dist/` and refuse to produce one that is already broken.
 *
 * There is nothing to transpile here: the site is hand-written HTML and CSS with
 * real screenshots, and keeping it that way is deliberate. So this build earns
 * its exit code by checking the things a copy cannot guarantee:
 *
 *  - every asset the HTML references exists in the output, so a renamed or
 *    forgotten screenshot fails the build instead of 404ing in production;
 *  - no image is referenced that is not shipped, and no image is shipped that
 *    nothing references, because a stale 300KB capture is dead weight a reviewer
 *    will not notice;
 *  - every internal anchor points at an id that exists in the document.
 *
 * A build that only copied files would exit 0 on a site with a missing hero
 * image, which makes its exit code worthless as a gate.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dir, "..");
const src = join(pkg, "public");
const out = join(pkg, "dist");

const problems: string[] = [];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

const html = readFileSync(join(out, "index.html"), "utf8");

/** Root-relative references only; external URLs are not ours to guarantee. */
function localRefs(attr: "src" | "href"): string[] {
  const re = new RegExp(`${attr}="(/[^"]*)"`, "g");
  return [...html.matchAll(re)].map(m => m[1] ?? "").filter(u => u.length > 0);
}

const referenced = new Set([...localRefs("src"), ...localRefs("href")]);
for (const ref of referenced) {
  const path = join(out, ref);
  if (!existsSync(path) || !statSync(path).isFile()) problems.push(`referenced but missing: ${ref}`);
}

// Shipped-but-unused images. Cheap to detect, and the only way a stale capture
// gets caught before it is committed forever.
const shotsDir = join(out, "shots");
if (existsSync(shotsDir)) {
  for (const name of readdirSync(shotsDir)) {
    if (!referenced.has(`/shots/${name}`)) problems.push(`shipped but unreferenced: /shots/${name}`);
  }
}

// Internal anchors must land somewhere real.
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1] ?? ""));
for (const m of html.matchAll(/href="#([^"]+)"/g)) {
  const id = m[1] ?? "";
  if (id.length > 0 && !ids.has(id)) problems.push(`anchor points at no such id: #${id}`);
}

const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter(f => f.endsWith(".png")).length : 0;
console.log(`  built ${out}`);
console.log(`  ${referenced.size} local references, ${shots} screenshots`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("  every reference resolves and every screenshot is used");
