/**
 * Pure verifiers for the macOS and iOS release chain.
 *
 * These exist because every step of that chain can succeed loudly and still
 * produce an artifact Apple rejects. Two real examples, both hit while building
 * the first ompctl release:
 *
 *  1. `xcodebuild archive` reported ARCHIVE SUCCEEDED while signing with the
 *     developer's *personal* Apple Development identity from a different team,
 *     because the project uses automatic signing and that identity sorted first.
 *     The archive was well-formed and useless for the App Store.
 *
 *  2. `productbuild` produced a correctly Developer ID Installer-signed package
 *     that the notary service rejected, because Xcode had not enabled the
 *     hardened runtime on the app's main executable. `codesign` was happy,
 *     `pkgutil --check-signature` was happy, and notarization returned Invalid.
 *
 * So the orchestrating script asserts properties of what it produced rather than
 * trusting exit codes. Parsing lives here, separate from the shelling out, so the
 * assertions can be tested against captured real output including the failures.
 */

/** The team that ompctl ships under. */
export const TEAM_ID = "8H7HVPHS87";

/**
 * Read the `flags=` field out of `codesign -d --verbose=2` output.
 *
 * Apple prints e.g. `flags=0x10000(runtime)` or `flags=0x0(none)`. The numeric
 * value is authoritative; the parenthesised names are a convenience.
 */
export function parseCodesignFlags(out: string): number | null {
  const m = out.match(/\bflags=0x([0-9a-fA-F]+)/);
  return m ? Number.parseInt(m[1]!, 16) : null;
}

/** CS_RUNTIME. Notarization rejects anything without it. */
export const CS_RUNTIME = 0x10000;

/**
 * Whether the hardened runtime is enabled.
 *
 * Returns false when the flags field is absent: an unparseable signature is not
 * evidence of a good one, and this is the exact check whose false pass cost a
 * failed notarization round-trip.
 */
export function hasHardenedRuntime(codesignOutput: string): boolean {
  const flags = parseCodesignFlags(codesignOutput);
  return flags !== null && (flags & CS_RUNTIME) !== 0;
}

/** Every `Authority=` line, outermost first, as Apple prints them. */
export function parseAuthorities(out: string): string[] {
  return [...out.matchAll(/^Authority=(.+)$/gm)].map(m => m[1]!.trim());
}

/** The `TeamIdentifier=` field, or null when absent. */
export function parseTeamIdentifier(out: string): string | null {
  const m = out.match(/^TeamIdentifier=(.+)$/m);
  return m ? m[1]!.trim() : null;
}

/** The `Identifier=` field (the bundle id), or null when absent. */
export function parseBundleIdentifier(out: string): string | null {
  const m = out.match(/^Identifier=(.+)$/m);
  return m ? m[1]!.trim() : null;
}

export interface SigningExpectation {
  /** Substring the leaf authority must start with, e.g. "Apple Distribution". */
  leafPrefix: string;
  /** Required team, defaults to ompctl's. */
  team?: string;
  /** Required bundle id. */
  bundleId?: string;
  /** Require CS_RUNTIME. Mandatory for anything notarized. */
  requireHardenedRuntime?: boolean;
}

export interface SigningVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * Assert a signature matches what the distribution channel requires.
 *
 * Checks the LEAF authority specifically. A Development-signed binary still
 * chains to "Apple Worldwide Developer Relations" and "Apple Root CA", so
 * searching the whole chain for something plausible passes on the wrong identity.
 */
export function verifySigning(codesignOutput: string, expect: SigningExpectation): SigningVerdict {
  const problems: string[] = [];
  const authorities = parseAuthorities(codesignOutput);
  const leaf = authorities[0];

  if (!leaf) {
    problems.push("no Authority= line: the artifact is unsigned or output was not parsed");
  } else if (!leaf.startsWith(expect.leafPrefix)) {
    problems.push(
      `leaf authority is ${JSON.stringify(leaf)}, expected it to start with ${JSON.stringify(expect.leafPrefix)}`,
    );
  }

  const team = expect.team ?? TEAM_ID;
  const actualTeam = parseTeamIdentifier(codesignOutput);
  if (actualTeam !== team) {
    problems.push(`TeamIdentifier is ${actualTeam ?? "absent"}, expected ${team}`);
  }

  if (expect.bundleId) {
    const actual = parseBundleIdentifier(codesignOutput);
    if (actual !== expect.bundleId) {
      problems.push(`Identifier is ${actual ?? "absent"}, expected ${expect.bundleId}`);
    }
  }

  if (expect.requireHardenedRuntime && !hasHardenedRuntime(codesignOutput)) {
    const flags = parseCodesignFlags(codesignOutput);
    problems.push(
      `hardened runtime not enabled (flags=${flags === null ? "absent" : `0x${flags.toString(16)}`}); the notary service will reject this`,
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Read the final status out of `notarytool submit --wait` output.
 *
 * `notarytool` exits 0 for a submission it successfully *tracked*, including one
 * the service rejected, so the exit code does not answer the question. The last
 * status does.
 *
 * Both spellings are collected in document order by one pattern: the repeated
 * `Current status: In Progress...` progress lines and the `status:` field in the
 * closing summary. Scanning them separately would leave the summary branch
 * holding at most one element, making its ordering untestable dead code.
 */
export function parseNotaryStatus(out: string): string | null {
  const seen = [...out.matchAll(/^\s*(?:Current\s+)?status:\s*([A-Za-z ]+?)\.*\s*$/gm)].map(m => m[1]!.trim());
  return seen.length ? seen[seen.length - 1]! : null;
}

/** Whether the notary service accepted the submission. */
export function notaryAccepted(out: string): boolean {
  return parseNotaryStatus(out) === "Accepted";
}

/** The submission id, for fetching the log when it is rejected. */
export function parseSubmissionId(out: string): string | null {
  const m = out.match(/\bid:\s*([0-9a-f-]{36})/i);
  return m ? m[1]! : null;
}

/**
 * Whether Gatekeeper considers the artifact notarized.
 *
 * `spctl` prints `source=Notarized Developer ID` only when a stapled ticket is
 * present. `accepted` alone is weaker: an unnotarized but validly signed package
 * can also be accepted under some policies, so both are required.
 */
export function gatekeeperNotarized(spctlOutput: string): boolean {
  return /:\s*accepted\b/.test(spctlOutput) && /source=Notarized\b/.test(spctlOutput);
}

/** Whether `stapler validate` reported success. */
export function stapleValid(staplerOutput: string): boolean {
  return /The (staple and validate|validate) action worked!/.test(staplerOutput);
}

/** An embedded provisioning profile that permits debugging is not a store build. */
export function profileIsStoreBuild(entitlements: Record<string, unknown>): boolean {
  return entitlements["get-task-allow"] !== true;
}
