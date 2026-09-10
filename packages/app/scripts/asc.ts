#!/usr/bin/env bun
/**
 * App Store Connect API helper for TestFlight builds.
 *
 * Implements JWT ES256 authentication using WebCrypto (Bun native).
 * Embeds no secrets: reads the API key and issuer ID from environment
 * variables or standard local key locations (~/.private_keys, ~/.appstoreconnect).
 *
 * Usage:
 *   bun scripts/asc.ts builds             # list recent builds and states
 *   bun scripts/asc.ts assign <build_id>  # assign build to internal beta group
 *   bun scripts/asc.ts nonexempt <id>     # mark non-exempt encryption false
 *   bun scripts/asc.ts group              # inspect beta group builds
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "";
const KEY_ID = process.env.OMPD_ASC_KEY_ID || "CKYD83GHF3";
function requireEnv(name: "OMPD_APP_ID" | "OMPD_BETA_GROUP_ID"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveIssuerId(): string {
  if (process.env.OMPD_ASC_ISSUER_ID) {
    return process.env.OMPD_ASC_ISSUER_ID.trim();
  }
  const candidate = join(HOME, ".private_keys", "asc_issuer_id");
  if (existsSync(candidate)) {
    return readFileSync(candidate, "utf8").trim();
  }
  throw new Error("Missing ASC issuer ID. Set OMPD_ASC_ISSUER_ID or ~/.private_keys/asc_issuer_id");
}

function resolveKeyPath(): string {
  if (process.env.OMPD_ASC_KEY_PATH && existsSync(process.env.OMPD_ASC_KEY_PATH)) {
    return process.env.OMPD_ASC_KEY_PATH;
  }
  const candidates = [
    join(HOME, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`),
    join(HOME, ".private_keys", `AuthKey_${KEY_ID}.p8`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Missing ASC private key AuthKey_${KEY_ID}.p8. Set OMPD_ASC_KEY_PATH or place in ~/.private_keys/`);
}

function b64url(b: Uint8Array | string): string {
  const buf = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createToken(): Promise<string> {
  const issuer = resolveIssuerId();
  const keyPath = resolveKeyPath();
  const pem = readFileSync(keyPath, "utf8");
  const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" }));
  const p = b64url(
    JSON.stringify({
      iss: issuer,
      iat: now,
      exp: now + 900,
      aud: "appstoreconnect-v1",
    }),
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

async function call(method: string, path: string, body?: unknown) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await createToken()}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 401 && attempt < 2) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1500);
      await promise;
      continue;
    }
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  throw new Error("ASC request failed after retries");
}

export type ApplePlatform = "IOS" | "MAC_OS";

interface BuildResource {
  id: string;
  attributes: {
    version: string;
    processingState: string;
    usesNonExemptEncryption?: boolean | null;
    uploadedDate?: string;
  };
  relationships?: { preReleaseVersion?: { data?: { id?: string } } };
}

interface BuildsResponse {
  data: BuildResource[];
  included?: Array<{ id: string; attributes?: { platform?: ApplePlatform } }>;
}

export function selectBuildByPlatform(
  response: BuildsResponse,
  buildNumber: string,
  platform: ApplePlatform,
): BuildResource | undefined {
  const platforms = new Map(response.included?.map(item => [item.id, item.attributes?.platform]));
  return response.data.find(build => {
    const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;
    return (
      build.attributes.version === buildNumber && preReleaseId !== undefined && platforms.get(preReleaseId) === platform
    );
  });
}

export function groupBuildPagePath(groupId: string, next: string): string {
  const url = new URL(next);
  if (
    url.origin !== "https://api.appstoreconnect.apple.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== `/v1/betaGroups/${groupId}/builds`
  ) {
    throw new Error("ASC returned an invalid tester-group pagination link");
  }
  return `${url.pathname}${url.search}`;
}

async function groupHasBuild(groupId: string, buildId: string): Promise<boolean> {
  let path: string | undefined = `/v1/betaGroups/${groupId}/builds?limit=200&fields[builds]=version,processingState`;
  while (path) {
    const res = await call("GET", path);
    if (res.status !== 200) throw new Error(`group builds returned ${res.status}: ${JSON.stringify(res.json)}`);
    if ((res.json.data as Array<{ id: string }>).some(build => build.id === buildId)) return true;
    const next = res.json.links?.next;
    path = typeof next === "string" && next !== "" ? groupBuildPagePath(groupId, next) : undefined;
  }
  return false;
}

async function ensureAssigned(buildId: string): Promise<void> {
  const groupId = requireEnv("OMPD_BETA_GROUP_ID");
  if (await groupHasBuild(groupId, buildId)) return;
  const res = await call("POST", `/v1/betaGroups/${groupId}/relationships/builds`, {
    data: [{ type: "builds", id: buildId }],
  });
  if (res.status !== 204) throw new Error(`assign returned ${res.status}: ${JSON.stringify(res.json)}`);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await groupHasBuild(groupId, buildId)) return;
    await Bun.sleep(2000);
  }
  throw new Error(`build ${buildId} was not visible in tester group after assignment`);
}

async function waitForBuildAndAssign(buildNumber: string, platform: ApplePlatform): Promise<void> {
  const appId = requireEnv("OMPD_APP_ID");
  const waitMs = Number(process.env.OMPD_ASC_BUILD_WAIT_MS ?? "3600000");
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error("OMPD_ASC_BUILD_WAIT_MS must be a positive number");
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const res = await call(
      "GET",
      `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&limit=20&include=preReleaseVersion&fields[builds]=version,processingState,usesNonExemptEncryption,uploadedDate,preReleaseVersion&fields[preReleaseVersions]=platform,version`,
    );
    if (res.status !== 200) throw new Error(`build lookup returned ${res.status}: ${JSON.stringify(res.json)}`);
    const build = selectBuildByPlatform(res.json as BuildsResponse, buildNumber, platform);
    if (build?.attributes.processingState === "INVALID") {
      throw new Error(`build ${buildNumber} for ${platform} is invalid`);
    }
    if (build?.attributes.processingState === "VALID") {
      if (build.attributes.usesNonExemptEncryption !== false) {
        const patched = await call("PATCH", `/v1/builds/${build.id}`, {
          data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
        });
        if (patched.status !== 200) {
          throw new Error(`nonexempt returned ${patched.status}: ${JSON.stringify(patched.json)}`);
        }
      }
      await ensureAssigned(build.id);
      console.log(`ready_assigned build=${buildNumber} platform=${platform} id=${build.id}`);
      return;
    }
    console.log(
      `waiting build=${buildNumber} platform=${platform} state=${build?.attributes.processingState ?? "missing"}`,
    );
    await Bun.sleep(15000);
  }
  throw new Error(`timed out waiting for build ${buildNumber} on ${platform}`);
}

async function main(): Promise<void> {
  const [cmd, arg, platformArg] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "help") {
    console.log("Usage: bun scripts/asc.ts <builds|assign|group|nonexempt|wait-assign> [args]");
    return;
  }

  if (cmd === "builds") {
    const appId = requireEnv("OMPD_APP_ID");
    const res = await call(
      "GET",
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,usesNonExemptEncryption,uploadedDate,expired`,
    );
    if (res.status !== 200) throw new Error(`builds returned ${res.status}: ${JSON.stringify(res.json)}`);
    for (const b of res.json.data) {
      console.log(
        `${b.id} build=${b.attributes.version} state=${b.attributes.processingState} nonexempt=${b.attributes.usesNonExemptEncryption} uploaded=${b.attributes.uploadedDate}`,
      );
    }
  } else if (cmd === "assign") {
    if (!arg) throw new Error("Missing build ID for assign");
    await ensureAssigned(arg);
    console.log("assign 204");
  } else if (cmd === "nonexempt") {
    if (!arg) throw new Error("Missing build ID for nonexempt");
    const res = await call("PATCH", `/v1/builds/${arg}`, {
      data: { type: "builds", id: arg, attributes: { usesNonExemptEncryption: false } },
    });
    console.log(`nonexempt ${res.status}`);
    if (res.status !== 200) throw new Error(`nonexempt returned ${res.status}`);
  } else if (cmd === "group") {
    const groupId = requireEnv("OMPD_BETA_GROUP_ID");
    const res = await call("GET", `/v1/betaGroups/${groupId}/builds?limit=5&fields[builds]=version,processingState`);
    if (res.status !== 200) throw new Error(`group returned ${res.status}: ${JSON.stringify(res.json)}`);
    const list = res.json.data.map(
      (b: { id: string; attributes: { version: string; processingState: string } }) =>
        `${b.id} build=${b.attributes.version} ${b.attributes.processingState}`,
    );
    console.log(res.status, JSON.stringify(list));
  } else if (cmd === "wait-assign") {
    if (!arg) throw new Error("Missing build number for wait-assign");
    if (platformArg !== "IOS" && platformArg !== "MAC_OS") {
      throw new Error("wait-assign platform must be IOS or MAC_OS");
    }
    await waitForBuildAndAssign(arg, platformArg);
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
}

if (import.meta.main) await main();
