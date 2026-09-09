/**
 * Verify the served marketing page: assets, anchors, reflow and accessibility.
 * Usage: bun run scripts/check-site.ts [baseUrl]
 */
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

/** Runs in the page. Also importable for proof through an attached browser. */
export async function inspectLayout() {
  await document.fonts.ready;
  const geometry = {
    viewport: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
    tour: document.getElementById("screens")?.getBoundingClientRect().height ?? 0,
    background: getComputedStyle(document.body).backgroundColor,
  };
  if (geometry.background !== "rgb(10, 12, 16)") throw new Error("site stylesheet has not applied");
  if (geometry.scroll !== geometry.client) {
    const offenders = [...document.querySelectorAll<HTMLElement>("pre, li, td, img")]
      .filter(element => element.getBoundingClientRect().right > geometry.client)
      .slice(0, 5)
      .map(
        element =>
          `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}: ${Math.round(element.getBoundingClientRect().width)}px`,
      );
    throw new Error(
      `page overflow at ${geometry.viewport}: scrollWidth ${geometry.scroll}, clientWidth ${geometry.client}; ${offenders.join(", ") || "outside the document bounds"}`,
    );
  }
  if (geometry.viewport === 390 && (geometry.tour <= 0 || geometry.tour >= 2500)) {
    throw new Error(`tour height at 390 must be between 0 and 2500px: ${geometry.tour}px`);
  }
  return geometry;
}

if (import.meta.main) {
  const base = (process.argv[2] ?? process.env.SITE_URL ?? "http://127.0.0.1:4399").replace(/\/$/, "");
  const failures: string[] = [];
  function check(label: string, ok: boolean, detail = ""): void {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures.push(label);
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
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

    const images = await page.evaluate(() =>
      [...document.images].map(image => ({
        src: image.getAttribute("src") ?? "?",
        width: image.naturalWidth,
        alt: image.alt.trim(),
      })),
    );
    check(
      "every image has intrinsic dimensions",
      images.every(image => image.width > 0),
      `${images.filter(image => image.width > 0).length}/${images.length}`,
    );
    check(
      "every image has descriptive alt text",
      images.every(image => image.alt.length >= 15),
    );

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

    const links = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(a => a.getAttribute("href") ?? ""),
    );
    for (const href of links) {
      check(`link has a valid destination: ${href}`, /^(?:https?:\/\/|\/(?!\/)|#)/.test(href));
    }

    const chapterCount = await page.locator(".tour-chapters details").count();
    check("the product tour has chapters to inspect", chapterCount > 0);
    for (const width of [1440, 768, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      // Exercise every disclosure: closed content must not conceal a wide child.
      for (let chapter = 0; chapter < chapterCount; chapter++) {
        await page.evaluate(index => {
          const chapters = [...document.querySelectorAll<HTMLDetailsElement>(".tour-chapters details")];
          for (const [i, detail] of chapters.entries()) detail.open = i === index;
        }, chapter);
        try {
          const geometry = await page.evaluate(inspectLayout);
          check(
            `layout at ${width}, chapter ${chapter + 1}`,
            true,
            `${geometry.scroll}/${geometry.client}px; tour ${geometry.tour}px; document ${geometry.height}px`,
          );
        } catch (error) {
          check(`layout at ${width}, chapter ${chapter + 1}`, false, String(error));
        }
      }
    }
    check("no runtime network dependencies", remoteRequests.size === 0, [...remoteRequests].join(", "));

    // Axe sees the full page and every expanded chapter on both surfaces.
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (let chapter = 0; chapter < chapterCount; chapter++) {
        await page.evaluate(index => {
          const chapters = [...document.querySelectorAll<HTMLDetailsElement>(".tour-chapters details")];
          for (const [i, detail] of chapters.entries()) detail.open = i === index;
        }, chapter);
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const blocking = axe.violations.filter(v => v.impact === "critical" || v.impact === "serious");
        for (const violation of blocking) {
          console.log(
            `  FAIL axe ${violation.impact}: ${violation.id} - ${violation.help} (${violation.nodes.length} node(s))`,
          );
          for (const node of violation.nodes.slice(0, 3)) console.log(`         ${node.html.slice(0, 110)}`);
        }
        check(`axe clean at ${width}, chapter ${chapter + 1}`, blocking.length === 0, `${blocking.length} blocking`);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nSite verified: local assets, unique anchors, image dimensions, no overflow, compact tour, axe clean.");
}
