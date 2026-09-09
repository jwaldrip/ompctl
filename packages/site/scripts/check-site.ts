/**
 * Verify the served marketing page: assets, anchors, reflow and accessibility.
 * SITE_CDP_URL attaches to an existing browser relay for local proof. Only the
 * page created by this run is touched. CI can launch its own browser as before.
 *
 * Usage: bun run scripts/check-site.ts [baseUrl]
 */
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const base = (process.argv[2] ?? process.env.SITE_URL ?? "http://127.0.0.1:4399").replace(/\/$/, "");
const cdpUrl = process.env.SITE_CDP_URL;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const browser = cdpUrl ? await chromium.connectOverCDP(cdpUrl) : await chromium.launch();
const context = cdpUrl ? browser.contexts()[0] : await browser.newContext();
if (!context) throw new Error("the attached browser has no page context");
const page = await context.newPage();
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  const remoteRequests = new Set<string>();
  page.on("request", request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== new URL(base).origin) remoteRequests.add(url.href);
  });
  const res = await page.goto(`${base}/?verify=${Date.now()}`, { waitUntil: "load" });
  check("site root responds 200", res?.status() === 200, `HTTP ${res?.status() ?? "no response"}`);

  // Refuse a stray server on the same port before interpreting its failures.
  const identity = await page.evaluate(() => ({
    title: document.title,
    wordmark: document.querySelector(".wordmark")?.textContent?.trim() ?? "",
  }));
  const ours = identity.wordmark === "ompctl" && /ompctl/i.test(identity.title);
  check("the page under test is the ompctl site", ours, `wordmark "${identity.wordmark}"`);
  if (!ours) throw new Error("refusing to audit a page that is not the ompctl site");

  const assets = await page.evaluate(() => {
    const urls = new Set<string>();
    for (const el of document.querySelectorAll<HTMLImageElement>("img[src]")) urls.add(el.src);
    for (const el of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) urls.add(el.href);
    return [...urls];
  });
  check("page references assets at all", assets.length > 0, `${assets.length} found`);
  for (const url of assets) {
    const local = new URL(url).origin === new URL(base).origin;
    check(`asset is hosted locally: ${url.slice(base.length)}`, local);
    if (!local) continue;
    const r = await page.request.get(url);
    check(`asset serves: ${url.slice(base.length)}`, r.status() === 200, `HTTP ${r.status()}`);
  }

  const images = await page.evaluate(async () => {
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    return [...document.images].map(image => ({
      src: image.getAttribute("src") ?? "?",
      width: image.naturalWidth,
      alt: image.alt.trim(),
    }));
  });
  check("every image decodes", images.every(image => image.width > 0), `${images.filter(image => image.width > 0).length}/${images.length}`);
  check("every image has descriptive alt text", images.every(image => image.alt.length >= 15));

  const destinations = await page.evaluate(() => {
    const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map(el => el.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const missing = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
      .map(a => a.hash.slice(1))
      .filter(id => id && !document.getElementById(id));
    return { duplicateIds, missing };
  });
  check("every id is unique", destinations.duplicateIds.length === 0, destinations.duplicateIds.join(", "));
  check("every internal anchor resolves", destinations.missing.length === 0, destinations.missing.join(", "));

  const links = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(a => a.getAttribute("href") ?? ""));
  for (const href of links) {
    check(`link has a valid destination: ${href}`, /^(?:https?:\/\/|\/(?!\/)|#)/.test(href));
  }

  const chapterCount = await page.locator(".tour-chapters details").count();
  for (const width of [1440, 768, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    // Exercise every disclosure: closed content must not conceal a wide child.
    for (let chapter = -1; chapter < chapterCount; chapter++) {
      await page.evaluate(index => {
        const chapters = [...document.querySelectorAll<HTMLDetailsElement>(".tour-chapters details")];
        for (const [i, detail] of chapters.entries()) detail.open = i === Math.max(0, index);
      }, chapter);
      const geometry = await page.evaluate(async () => {
        await document.fonts.ready;
        return {
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          height: document.documentElement.scrollHeight,
          tour: document.getElementById("screens")?.getBoundingClientRect().height ?? 0,
          background: getComputedStyle(document.body).backgroundColor,
        };
      });
      const state = chapter === -1 ? "default" : `chapter ${chapter + 1}`;
      check(`no page overflow at ${width}, ${state}`, geometry.scroll === geometry.client, `${geometry.scroll}/${geometry.client}px`);
      check(`stylesheet applied at ${width}, ${state}`, geometry.background === "rgb(10, 12, 16)");
      if (width === 390) {
        check(`tour stays under 2500px, ${state}`, geometry.tour > 0 && geometry.tour < 2500, `${geometry.tour}px; document ${geometry.height}px`);
      }
    }
  }
  check("no runtime network dependencies", remoteRequests.size === 0, [...remoteRequests].join(", "));

  // Axe runs against the full default page and each expanded chapter on mobile.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (let chapter = 0; chapter < chapterCount; chapter++) {
      await page.evaluate(index => {
        const chapters = document.querySelectorAll<HTMLDetailsElement>(".tour-chapters details");
        chapters[index]?.setAttribute("open", "");
      }, chapter);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = axe.violations.filter(v => v.impact === "critical" || v.impact === "serious");
      for (const violation of blocking) {
        console.log(`  FAIL axe ${violation.impact}: ${violation.id} - ${violation.help} (${violation.nodes.length} node(s))`);
        for (const node of violation.nodes.slice(0, 3)) console.log(`         ${node.html.slice(0, 110)}`);
      }
      check(`axe clean at ${width}, chapter ${chapter + 1}`, blocking.length === 0, `${blocking.length} blocking`);
    }
  }
} finally {
  await page.close();
  // For connectOverCDP, Playwright disconnects; it does not close the remote browser.
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSite verified: local assets, unique anchors, decoded images, no overflow, compact tour, axe clean.");
