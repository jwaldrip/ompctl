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
const APP_ID = process.env.OMPD_APP_ID || "6802417672";
const GROUP_ID = process.env.OMPD_BETA_GROUP_ID || "50ac3e8f-19d6-44bd-beb4-8955e262fa52";

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

const [cmd, arg] = process.argv.slice(2);

if (!cmd || cmd === "--help" || cmd === "help") {
  console.log("Usage: bun scripts/asc.ts <builds|assign|group|nonexempt> [args]");
  process.exit(0);
}

if (cmd === "builds") {
  const res = await call(
    "GET",
    `/v1/builds?filter[app]=${APP_ID}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,usesNonExemptEncryption,uploadedDate,expired`,
  );
  if (res.status !== 200) throw new Error(`builds returned ${res.status}: ${JSON.stringify(res.json)}`);
  for (const b of res.json.data) {
    console.log(
      `${b.id} build=${b.attributes.version} state=${b.attributes.processingState} nonexempt=${b.attributes.usesNonExemptEncryption} uploaded=${b.attributes.uploadedDate}`,
    );
  }
} else if (cmd === "assign") {
  if (!arg) throw new Error("Missing build ID for assign");
  const { status } = await call("POST", `/v1/betaGroups/${GROUP_ID}/relationships/builds`, {
    data: [{ type: "builds", id: arg }],
  });
  console.log(`assign ${status}`);
  if (status !== 204) process.exit(1);
} else if (cmd === "nonexempt") {
  if (!arg) throw new Error("Missing build ID for nonexempt");
  const { status } = await call("PATCH", `/v1/builds/${arg}`, {
    data: { type: "builds", id: arg, attributes: { usesNonExemptEncryption: false } },
  });
  console.log(`nonexempt ${status}`);
  if (status !== 200) process.exit(1);
} else if (cmd === "group") {
  const { status, json } = await call(
    "GET",
    `/v1/betaGroups/${GROUP_ID}/builds?limit=5&fields[builds]=version,processingState`,
  );
  const list = json?.data?.map(
    (b: { id: string; attributes: { version: string; processingState: string } }) =>
      `${b.id} build=${b.attributes.version} ${b.attributes.processingState}`,
  );
  console.log(status, JSON.stringify(list));
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
