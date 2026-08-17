/**
 * Verify the marketing site: every internal reference resolves, and axe reports
 * no critical or serious violations.
 *
 * Runs against the site served over HTTP rather than against the files on disk.
 * A `file://` check would pass on absolute paths like `/styles.css` that 404 the
 * moment the thing is hosted, which is exactly the failure worth catching.
 *
 * Assets are checked by fetching them, not by reading the directory. A stylesheet
 * that exists but is served as 404 by a misrouted host is still broken, and only
 * a request can tell the difference.
 *
 * Usage: bun run scripts/check-site.ts [baseUrl]
 */

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const base = (process.argv[2] ?? process.env.SITE_URL ?? "http://127.0.0.1:4399").replace(/\/$/, "");

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch();
try {
  // `newContext` rather than `newPage`: @axe-core/playwright refuses a page that
  // was created directly off the browser.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const res = await page.goto(base, { waitUntil: "load" });
  check("site root responds 200", res?.status() === 200, `HTTP ${res?.status() ?? "no response"}`);

  /*
   * Prove this is OUR site before auditing it.
   *
   * Without this the check is worse than useless: a stale dev server for an
   * unrelated project was already holding the same port on IPv4 while ours bound
   * IPv6, and the run audited that stranger's marketing site and reported its
   * links as our failures. A verifier that cannot tell whose page it loaded
   * cannot be trusted when it passes either.
   */
  const identity = await page.evaluate(() => ({
    title: document.title,
    wordmark: document.querySelector(".wordmark")?.textContent?.trim() ?? "",
  }));
  check(
    "the page under test is the ompctl site",
    identity.wordmark === "ompctl" && /ompctl/i.test(identity.title),
    `wordmark "${identity.wordmark}", title "${identity.title.slice(0, 40)}"`,
  );
  if (identity.wordmark !== "ompctl") {
    console.error("\nrefusing to audit a page that is not the ompctl site");
    process.exit(1);
  }

  // --- every referenced asset actually serves ---------------------------
  const assets = await page.evaluate(() => {
    const urls = new Set<string>();
    for (const el of document.querySelectorAll<HTMLImageElement>("img[src]")) urls.add(el.src);
    for (const el of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) urls.add(el.href);
    return [...urls];
  });
  check("page references assets at all", assets.length > 0, `${assets.length} found`);
  for (const url of assets) {
    // Third-party font CDNs are out of scope: this checks what we host.
    if (!url.startsWith(base)) continue;
    const r = await page.request.get(url);
    check(`asset serves: ${url.slice(base.length)}`, r.status() === 200, `HTTP ${r.status()}`);
  }

  // --- images must carry real alt text ---------------------------------
  // Screenshots are the content here, so an empty alt is a missing caption for
  // anyone using a screen reader, not a decorative-image exemption.
  const badAlt = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>("img")]
      .filter(i => (i.getAttribute("alt") ?? "").trim().length < 15)
      .map(i => i.getAttribute("src") ?? "?"),
  );
  check("every image has descriptive alt text", badAlt.length === 0, badAlt.join(", "));

  // --- internal anchors resolve to real elements ------------------------
  const anchors = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map(a => a.getAttribute("href") ?? ""),
  );
  for (const href of anchors) {
    const id = href.slice(1);
    if (id.length === 0) continue;
    const found = await page.evaluate(target => document.getElementById(target) !== null, id);
    check(`anchor resolves: ${href}`, found);
  }

  // --- links that leave the page must at least be absolute --------------
  const external = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .map(a => a.getAttribute("href") ?? "")
      .filter(h => !h.startsWith("#")),
  );
  for (const href of external) {
    check(`link is absolute: ${href}`, /^https?:\/\//.test(href));
  }

  // --- accessibility ----------------------------------------------------
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = axe.violations.filter(v => v.impact === "critical" || v.impact === "serious");
  for (const v of blocking) {
    console.log(`  FAIL axe ${v.impact}: ${v.id} - ${v.help} (${v.nodes.length} node(s))`);
    for (const n of v.nodes.slice(0, 3)) console.log(`         ${n.html.slice(0, 110)}`);
  }
  check("axe reports no critical or serious violations", blocking.length === 0, `${blocking.length} blocking`);
  const minor = axe.violations.length - blocking.length;
  if (minor > 0) console.log(`  note: ${minor} moderate/minor axe finding(s), not treated as blocking`);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSite verified: assets serve, anchors resolve, alt text present, axe clean.");
