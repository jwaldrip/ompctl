#!/usr/bin/env bun
/**
 * Verify the three public endpoints, by content rather than by status code.
 *
 *   bun run scripts/check-endpoints.ts
 *
 * Every assertion here exists because the status-code version of it passes right
 * now while the thing it is supposed to prove is false.
 *
 * ompctl.ai currently answers HTTP 200 over a valid certificate whose CN is
 * ompctl.ai, and serves a Squarespace page titled "Coming Soon". A check that
 * accepts 200, or that accepts a valid TLS handshake, reports the marketing site
 * as live when no marketing site has been deployed. So the root is asserted on
 * its wordmark, and `check-site.ts` is the deeper audit once that passes.
 *
 * The association files are worse, because a wrong-but-well-formed document is
 * indistinguishable from a correct one at the HTTP layer. Apple treats a missing
 * or malformed apple-app-site-association as no association at all, silently:
 * Universal Links just stop opening the app, with no error anywhere. So the
 * documents are parsed and their contents checked against the real team and
 * bundle identifiers, not merely fetched.
 *
 * A dead name is reported as a failure with its DNS state, never as a skip. An
 * endpoint that does not resolve is the most likely real-world outcome of a
 * botched nameserver move, and it must not read as "nothing to check".
 */
import { resolve4, resolveCname } from "node:dns/promises";

const TEAM_ID = "8H7HVPHS87";
const BUNDLE_IOS = "ai.ompctl.app";
const BUNDLE_MAC = "ai.ompctl.macos";
const ANDROID_PKG = "ai.ompctl.app";

/*
 * Origins default to production. They are overridable so the assertions can be
 * exercised against a locally running server, which is what proves they are
 * satisfiable at all. A check that can never pass is no more useful than one
 * that can never fail, and both look identical in a red build.
 */
const ROOT_ORIGIN = process.env.OMPCTL_ROOT_ORIGIN ?? "https://ompctl.ai";
const HUB_ORIGIN = process.env.OMPCTL_HUB_ORIGIN ?? "https://hub.ompctl.ai";
const APP_ORIGIN = process.env.OMPCTL_APP_ORIGIN ?? "https://app.ompctl.ai";

/** Host portion, for the DNS state reported alongside a failure. */
const hostOf = (origin: string): string => new URL(origin).hostname;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

async function dnsState(host: string): Promise<string> {
  try {
    const a = await resolve4(host);
    return `A ${a.slice(0, 2).join(",")}`;
  } catch {
    try {
      const c = await resolveCname(host);
      return `CNAME ${c[0]}`;
    } catch {
      return "does not resolve";
    }
  }
}

interface Fetched {
  status: number | null;
  body: string;
  contentType: string;
  error?: string;
}

async function get(url: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "ompctl-endpoint-check" },
    });
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get("content-type") ?? "",
    };
  } catch (e) {
    return { status: null, body: "", contentType: "", error: String((e as Error).message ?? e) };
  }
}

// --- the root: must serve OUR site, not merely answer -----------------------
console.log(ROOT_ORIGIN);
{
  const host = hostOf(ROOT_ORIGIN);
  const dns = await dnsState(host);
  const r = await get(`${ROOT_ORIGIN}/`);
  check(`${host} responds`, r.status === 200, `${r.status ?? r.error} | ${dns}`);
  // A 200 from a placeholder is the failure mode, so assert identity.
  const isOurs = /ompctl/i.test(r.body) && !/squarespace/i.test(r.body);
  check(
    `${host} serves the ompctl marketing site, not a placeholder`,
    r.status === 200 && isOurs,
    /squarespace/i.test(r.body) ? "served by Squarespace" : `${r.body.length} bytes`,
  );
}

// --- the hub relay ----------------------------------------------------------
console.log(HUB_ORIGIN);
{
  const host = hostOf(HUB_ORIGIN);
  const dns = await dnsState(host);
  const r = await get(`${HUB_ORIGIN}/healthz`);
  check(`${host}/healthz responds 200 over TLS`, r.status === 200, `${r.status ?? r.error} | ${dns}`);
}

// --- the association documents ----------------------------------------------
console.log(APP_ORIGIN);
{
  const host = hostOf(APP_ORIGIN);
  const dns = await dnsState(host);

  const aasaUrl = `${APP_ORIGIN}/.well-known/apple-app-site-association`;
  const aasa = await get(aasaUrl);
  check("apple-app-site-association responds 200", aasa.status === 200, `${aasa.status ?? aasa.error} | ${dns}`);
  // Apple rejects a redirect for this document outright.
  // Written first as `status === null || 2xx`, which reported ok for a host that
  // does not resolve. A dead endpoint is not a non-redirecting one, and that
  // spurious pass is the exact shape of bug this file exists to prevent.
  check(
    "apple-app-site-association is not a redirect",
    aasa.status !== null && aasa.status >= 200 && aasa.status < 300,
    `HTTP ${aasa.status ?? "n/a"}`,
  );
  check(
    "apple-app-site-association is served as JSON",
    aasa.contentType.includes("json"),
    aasa.contentType || "no content-type",
  );

  let aasaOk = false;
  let aasaDetail = "unparsed";
  if (aasa.status === 200) {
    try {
      const doc = JSON.parse(aasa.body) as {
        applinks?: { apps?: unknown[]; details?: Array<{ appIDs?: string[] }> };
        webcredentials?: { apps?: string[] };
      };
      const ids = new Set((doc.applinks?.details ?? []).flatMap(d => d.appIDs ?? []));
      const wantIos = `${TEAM_ID}.${BUNDLE_IOS}`;
      const wantMac = `${TEAM_ID}.${BUNDLE_MAC}`;
      // `apps` must be present-and-empty; Apple treats a missing key as malformed.
      const appsPresent = Array.isArray(doc.applinks?.apps);
      const creds = new Set(doc.webcredentials?.apps ?? []);
      aasaOk = appsPresent && ids.has(wantIos) && ids.has(wantMac) && creds.has(wantIos) && creds.has(wantMac);
      aasaDetail = `apps[]=${appsPresent} appIDs=${[...ids].join(",") || "none"}`;
    } catch (e) {
      aasaDetail = `not JSON: ${String((e as Error).message).slice(0, 60)}`;
    }
  } else {
    aasaDetail = "endpoint did not serve";
  }
  check("apple-app-site-association claims both real bundle ids", aasaOk, aasaDetail);

  const alUrl = `${APP_ORIGIN}/.well-known/assetlinks.json`;
  const al = await get(alUrl);
  check("assetlinks.json responds 200", al.status === 200, `${al.status ?? al.error} | ${dns}`);

  let alOk = false;
  let alDetail = "endpoint did not serve";
  if (al.status === 200) {
    try {
      const doc = JSON.parse(al.body) as Array<{
        relation?: string[];
        target?: { package_name?: string; sha256_cert_fingerprints?: string[] };
      }>;
      const entry = doc.find(d => d.target?.package_name === ANDROID_PKG);
      const prints = entry?.target?.sha256_cert_fingerprints ?? [];
      // A fingerprint that is absent, empty, or an obvious placeholder means App
      // Links silently do not verify.
      const realPrint = prints.some(p => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(p) && !/^(AB:)+/i.test(p));
      alOk = Boolean(entry) && realPrint;
      alDetail = `package=${entry?.target?.package_name ?? "missing"} fingerprints=${prints.length}`;
    } catch (e) {
      alDetail = `not JSON: ${String((e as Error).message).slice(0, 60)}`;
    }
  }
  check("assetlinks.json carries a real cert fingerprint", alOk, alDetail);
}

console.log();
if (failures.length > 0) {
  console.error(`Endpoints NOT verified: ${failures.length} failing assertion(s).`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Endpoints verified: root serves the site, hub answers, both association documents are real.");
