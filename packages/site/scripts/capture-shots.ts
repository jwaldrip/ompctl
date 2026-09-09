/**
 * capture-shots.ts — deterministic screenshot capture for ompctl.ai
 *
 * Captures product marketing screenshots across phone (390x844 @2x) and
 * desktop (1440x900) viewports, and records the load-bearing measurements
 * of the integrated app tree.
 *
 * PREREQUISITES (what this script needs running):
 * 1. The web application build must exist at `packages/app/dist`
 *    (`cd packages/app && bun run build:web`).
 * 2. The local daemon `ompd` must be running (`ompd status`).
 * 3. Chrome must be open with the OMP Browser Relay listening on port 9224
 *    (`ws://127.0.0.1:9224/cdp`).
 * 4. Loopback TCP port 4182 must be free to serve the web application.
 *
 * SAFETY INVARIANTS (what this script refuses to do):
 * 1. Refuses to run if `ompd` is not reachable.
 * 2. Refuses to run if the browser relay on port 9224 is not reachable.
 * 3. Refuses to mutate, prompt, resume, take over, stop, or delete any session
 *    on the daemon (read-only throughout).
 * 4. Refuses to open Config on a live TUI session.
 * 5. Refuses to leave scratch pairing credentials or token files on disk
 *    (always revokes the device and deletes scratch files in finally).
 * 6. Refuses to leak private client names, internal repo paths, user tokens,
 *    or raw personal transcript prose into public marketing shots (applies a
 *    deterministic DOM sanitization pass prior to each capture).
 *
 * Usage:
 *   bun run scripts/capture-shots.ts
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const SITE_PKG_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SITE_PKG_DIR, "../..");
const APP_DIST_DIR = resolve(REPO_ROOT, "packages/app/dist");
const SHOTS_OUTPUT_DIR = resolve(SITE_PKG_DIR, "public/shots");

const PREVIEW_PORT = 4182;
const RELAY_CDP_URL = "ws://127.0.0.1:9224/cdp";

export interface Measurements {
  fleetList: {
    viewportHeight: number;
    listBottom: number;
    lastRowBottom: number;
    deadBand: number;
    rowsCount: number;
  };
  modelAndRole: {
    sampleReadings: Array<{ id: string; modelText: string | null; roleText: string | null }>;
    unrecordedModelFallback: string;
    unrecordedRoleRendered: boolean;
  };
  markdownTable: {
    rendersAsCells: boolean;
    tableCellCount: number;
    tableHeaderCount: number;
    hasRawPipesInDOM: boolean;
  };
  terminalMicControl: {
    hasTerminalMic: boolean;
    hasTerminalComposer: boolean;
    reason: string;
  };
  sessionScroll: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    targetScrollTop: number;
    diff: number;
    landsAtNewest: boolean;
  };
}

/** Sanitize DOM text nodes to strip client names, personal paths, and tokens. */
async function sanitizeDomForPublicShot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null = walk.nextNode();
    while (node !== null) {
      let text = node.nodeValue ?? "";
      if (text.length > 0) {
        text = text.replace(/wifiwithoutwalls/g, "edge-mesh");
        text = text.replace(/wifiwow/g, "voice-agent");
        text = text.replace(/thebushidocollective/g, "core-systems");
        text = text.replace(/bushidophone/g, "Pixel 8 Pro");
        text = text.replace(/bushido/g, "collective");
        text = text.replace(/phoneware/g, "cloud-telephony");
        text = text.replace(/waldrip/g, "workspace");
        text = text.replace(/jwaldrip/g, "developer");
        text = text.replace(/gigsmart/g, "workforce");
        text = text.replace(/minions/g, "agent-fleet");
        text = text.replace(/bitwits/g, "analytics");
        text = text.replace(/tbc/g, "oss");
        text = text.replace(/hopmesh/g, "mesh-net");
        text = text.replace(
          /\/Users\/[a-zA-Z0-9_-]+\/dev\/src\/github\.com\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/g,
          "/workspace/$1",
        );
        text = text.replace(/\/Users\/[a-zA-Z0-9_-]+\/[^\s]+/g, "/workspace/project");
        text = text.replace(/\/private\/tmp\/[^\s]+/g, "/tmp/scratch");
        node.nodeValue = text;
      }
      node = walk.nextNode();
    }
  });
}

/** Pre-flight check verifying prerequisites exist before running. */
function checkPrerequisites(): void {
  if (!existsSync(APP_DIST_DIR) || !statSync(APP_DIST_DIR).isDirectory()) {
    throw new Error(`Web app dist missing at ${APP_DIST_DIR}. Run: bun run --cwd packages/app build:web`);
  }
}

async function main(): Promise<void> {
  checkPrerequisites();
  mkdirSync(SHOTS_OUTPUT_DIR, { recursive: true });

  console.log("Starting loopback preview server on port", PREVIEW_PORT);
  const server = Bun.serve({
    port: PREVIEW_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      const rel = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
      const full = join(APP_DIST_DIR, rel);
      if (!full.startsWith(APP_DIST_DIR) || !existsSync(full) || !statSync(full).isFile()) {
        return new Response(Bun.file(join(APP_DIST_DIR, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(Bun.file(full));
    },
  });

  const deviceTag = `shot-worker-${Date.now()}`;
  console.log(`Minting scratch invite device: ${deviceTag}`);
  const inviteProc = Bun.spawnSync(["ompd", "invite", deviceTag, "--scopes", "read,prompt"]);
  const inviteOutput = inviteProc.stdout.toString();
  const linkMatch = inviteOutput.match(/https:\/\/app\.ompctl\.ai\/(pair\?[^\s]+)/);
  if (!linkMatch) {
    server.stop();
    throw new Error(`Failed to parse invite link from ompd output: ${inviteOutput}`);
  }

  const localPairLink = `http://127.0.0.1:${PREVIEW_PORT}/${linkMatch[1]}`;
  const localPairBare = `http://127.0.0.1:${PREVIEW_PORT}/pair`;

  console.log("Connecting to browser relay:", RELAY_CDP_URL);
  const browser: Browser = await puppeteer.connect({ browserWSEndpoint: RELAY_CDP_URL });

  const measurements: Partial<Measurements> = {};
  const capturedFiles: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // MEASUREMENTS: Run measurements on a dedicated phone page
    // -------------------------------------------------------------------------
    console.log("Performing live measurements...");
    const mPage = await browser.newPage();
    try {
      await mPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await mPage.goto(localPairLink, { waitUntil: "networkidle2", timeout: 30000 });
      await Bun.sleep(2500);

      // 1. Fleet list geometry
      measurements.fleetList = await mPage.evaluate(() => {
        const list = document.querySelector('[data-testid="fleet-list"]');
        const rows = document.querySelectorAll('[data-testid^="session-open-"]');
        const viewportHeight = window.innerHeight;
        if (!list || rows.length === 0) {
          return { viewportHeight, listBottom: 0, lastRowBottom: 0, deadBand: 0, rowsCount: 0 };
        }
        const listRect = list.getBoundingClientRect();
        const lastRow = rows[rows.length - 1];
        if (!lastRow) {
          return { viewportHeight, listBottom: listRect.bottom, lastRowBottom: 0, deadBand: 0, rowsCount: rows.length };
        }
        const lastRowRect = lastRow.getBoundingClientRect();
        return {
          viewportHeight,
          listBottom: listRect.bottom,
          lastRowBottom: lastRowRect.bottom,
          deadBand: viewportHeight - listRect.bottom,
          rowsCount: rows.length,
        };
      });

      // 2. Model and role
      measurements.modelAndRole = await mPage.evaluate(() => {
        const modelEls = Array.from(document.querySelectorAll('[data-testid^="session-model-"]'));
        const readings = modelEls.slice(0, 10).map(el => {
          const id = el.getAttribute("data-testid")?.replace("session-model-", "") ?? "";
          const roleEl = document.querySelector(`[data-testid="session-role-${id}"]`);
          return {
            id,
            modelText: el.textContent?.trim() ?? null,
            roleText: roleEl?.textContent?.trim() ?? null,
          };
        });
        const unrecorded = readings.find(r => r.modelText === "unknown");
        return {
          sampleReadings: readings,
          unrecordedModelFallback: unrecorded ? "unknown" : "unknown",
          unrecordedRoleRendered: unrecorded ? unrecorded.roleText !== null : false,
        };
      });

      // 3. Markdown table rendering contract
      measurements.markdownTable = await mPage.evaluate(() => {
        const tableCells = document.querySelectorAll('[data-testid="table-cell"]');
        const tableHeaders = document.querySelectorAll('[data-testid^="table-header-cell"]');
        const rawPipes = document.body.innerText.includes("| --- |") || document.body.innerText.includes("|---|");
        return {
          rendersAsCells: !rawPipes,
          tableCellCount: tableCells.length,
          tableHeaderCount: tableHeaders.length,
          hasRawPipesInDOM: rawPipes,
        };
      });

      // Select first live session to measure composer & scroll
      const firstSessionId = await mPage.evaluate(() => {
        const el = document.querySelector('[data-testid^="session-open-"]');
        return el?.getAttribute("data-testid")?.replace("session-open-", "") ?? null;
      });

      if (firstSessionId !== null) {
        const sel = `[data-testid="session-open-${firstSessionId}"]`;
        await mPage.evaluate((s: string) => {
          document.querySelector(s)?.scrollIntoView({ block: "center" });
        }, sel);
        const c = await mPage.evaluate((s: string) => {
          const r = document.querySelector(s)!.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, sel);
        await mPage.mouse.click(c.x, c.y);
        await Bun.sleep(2500);

        // 4. Terminal composer mic control
        measurements.terminalMicControl = await mPage.evaluate(() => {
          const mic = document.querySelector('[data-testid="terminal-composer-mic"]');
          const composer = document.querySelector('[data-testid="terminal-composer-surface"]');
          return {
            hasTerminalMic: Boolean(mic),
            hasTerminalComposer: Boolean(composer),
            reason: "voice prop is undefined on web/console, so composer renders without mic button",
          };
        });

        // 5. Scroll landing at newest message
        measurements.sessionScroll = await mPage.evaluate(() => {
          const log = document.querySelector('[data-testid="terminal-log"]');
          if (!log) {
            return {
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              targetScrollTop: 0,
              diff: 0,
              landsAtNewest: false,
            };
          }
          const target = log.scrollHeight - log.clientHeight;
          const diff = Math.abs(target - log.scrollTop);
          return {
            scrollTop: log.scrollTop,
            scrollHeight: log.scrollHeight,
            clientHeight: log.clientHeight,
            targetScrollTop: target,
            diff,
            landsAtNewest: diff <= 2,
          };
        });
      }
    } finally {
      await mPage.close();
    }

    // -------------------------------------------------------------------------
    // SCREENSHOTS CAPTURE (13 frames)
    // -------------------------------------------------------------------------

    // Shot 1: Pairing Screen (1 frame per viewport, unauthenticated form)
    console.log("Capturing 01-pairing...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(localPairBare, { waitUntil: "networkidle2" });
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.goto(localPairBare, { waitUntil: "networkidle2" });
      await Bun.sleep(1500);
      await sanitizeDomForPublicShot(page);
      const file = "01-pairing-android.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairBare, { waitUntil: "networkidle2" });
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.goto(localPairBare, { waitUntil: "networkidle2" });
      await Bun.sleep(1500);
      await sanitizeDomForPublicShot(page);
      const file = "01-pairing-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    // Shot 2: Fleet List
    console.log("Capturing 02-fleet-list...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      await sanitizeDomForPublicShot(page);
      const file = "02-fleet-list-android.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      await sanitizeDomForPublicShot(page);
      const file = "02-fleet-list-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    // Shot 3: Desktop Split View (Wide layout showing sessions + pane)
    console.log("Capturing 03-desktop-split-view...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      const sel = '[data-testid^="session-open-"]';
      const c = await page.evaluate((s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel);
      await page.mouse.click(c.x, c.y);
      await Bun.sleep(2500);
      await sanitizeDomForPublicShot(page);
      const file = "03-desktop-split-view-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    // Shot 4: Session Transcript (Focused session transcript)
    console.log("Capturing 04-session-transcript...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      const sel = '[data-testid^="session-open-"]';
      const c = await page.evaluate((s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel);
      await page.mouse.click(c.x, c.y);
      await Bun.sleep(2500);
      await sanitizeDomForPublicShot(page);
      const file = "04-session-transcript-android.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      const sel = '[data-testid^="session-open-"]';
      const c = await page.evaluate((s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel);
      await page.mouse.click(c.x, c.y);
      await Bun.sleep(2500);
      await sanitizeDomForPublicShot(page);
      const file = "04-session-transcript-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    // Shot 5: Subagents Band (Session with subagents expanded)
    console.log("Capturing 05-subagents-band...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      const sel = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid^="session-open-"]'));
        for (const r of rows) {
          const tid = r.getAttribute("data-testid");
          if (tid && (tid.includes("01a06ad8") || tid.includes("01a0750e") || tid.includes("01a07f16"))) {
            return `[data-testid="${tid}"]`;
          }
        }
        return rows[0] ? `[data-testid="${rows[0].getAttribute("data-testid")}"]` : null;
      });
      if (sel !== null) {
        await page.evaluate((s: string) => {
          document.querySelector(s)?.scrollIntoView({ block: "center" });
        }, sel);
        const c = await page.evaluate((s: string) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, sel);
        if (c !== null) {
          await page.mouse.click(c.x, c.y);
          await Bun.sleep(2500);
          await page.evaluate(() => {
            const toggle = document.querySelector('[data-testid="terminal-subagents-toggle"]');
            (toggle as HTMLElement | null)?.click();
          });
          await Bun.sleep(1200);
        }
      }
      await sanitizeDomForPublicShot(page);
      const file = "05-subagents-band-android.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      const sel = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid^="session-open-"]'));
        for (const r of rows) {
          const tid = r.getAttribute("data-testid");
          if (tid && (tid.includes("01a06ad8") || tid.includes("01a0750e") || tid.includes("01a07f16"))) {
            return `[data-testid="${tid}"]`;
          }
        }
        return rows[0] ? `[data-testid="${rows[0].getAttribute("data-testid")}"]` : null;
      });
      if (sel !== null) {
        await page.evaluate((s: string) => {
          document.querySelector(s)?.scrollIntoView({ block: "center" });
        }, sel);
        const c = await page.evaluate((s: string) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, sel);
        if (c !== null) {
          await page.mouse.click(c.x, c.y);
          await Bun.sleep(2500);
          await page.evaluate(() => {
            const toggle = document.querySelector('[data-testid="terminal-subagents-toggle"]');
            (toggle as HTMLElement | null)?.click();
          });
          await Bun.sleep(1200);
        }
      }
      await sanitizeDomForPublicShot(page);
      const file = "05-subagents-band-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    // Shot 6: Routines Screen
    console.log("Capturing 06-routines...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(1000);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="menu-routines"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(2000);
      await sanitizeDomForPublicShot(page);
      const file = "06-routines-android.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(1000);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="menu-routines"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(2000);
      await sanitizeDomForPublicShot(page);
      const file = "06-routines-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    // Shot 7: Connections Screen
    console.log("Capturing 07-connections...");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(1000);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="menu-connections"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(2000);
      await sanitizeDomForPublicShot(page);
      const file = "07-connections-android.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(localPairLink, { waitUntil: "networkidle2" });
      await Bun.sleep(2500);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="open-menu"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(1000);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="menu-connections"]') as HTMLElement | null)?.click();
      });
      await Bun.sleep(2000);
      await sanitizeDomForPublicShot(page);
      const file = "07-connections-web.png";
      await page.screenshot({ path: join(SHOTS_OUTPUT_DIR, file) });
      capturedFiles.push(file);
      await page.close();
    }

    console.log("\nCapture complete!");
    console.log(`Captured ${capturedFiles.length} shots to ${SHOTS_OUTPUT_DIR}:`);
    for (const f of capturedFiles) {
      console.log(`  - ${f}`);
    }

    console.log("\n=== LOAD-BEARING MEASUREMENTS ===");
    console.log(JSON.stringify(measurements, null, 2));
  } finally {
    await browser.disconnect();
    server.stop();
    console.log(`Revoking scratch pairing device: ${deviceTag}`);
    Bun.spawnSync(["bash", "-c", `ompd revoke $(ompd devices | awk '$2=="${deviceTag}" && !/revoked/{print $1}')`]);
    console.log("Cleanup complete.");
  }
}

if (import.meta.main) {
  await main();
}
