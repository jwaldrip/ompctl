/**
 * Every sample below is real output captured while producing the first ompctl
 * release, including the two artifacts that were wrong. That matters: a verifier
 * written only against the passing case is indistinguishable from one that always
 * returns true, and both of these defects presented as success elsewhere in the
 * toolchain.
 */
import { describe, expect, test } from "bun:test";
import {
  CS_RUNTIME,
  gatekeeperNotarized,
  hasHardenedRuntime,
  notaryAccepted,
  parseAuthorities,
  parseBundleIdentifier,
  parseCodesignFlags,
  parseNotaryStatus,
  parseSubmissionId,
  parseTeamIdentifier,
  profileIsStoreBuild,
  stapleValid,
  TEAM_ID,
  verifySigning,
} from "./verify.ts";

/** The exported .ipa, correctly signed for the App Store. */
const IPA_GOOD = `Identifier=ai.ompctl.app
Format=app bundle with Mach-O thin (arm64)
Signature size=4784
Authority=Apple Distribution: Jason Waldrip (8H7HVPHS87)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=8H7HVPHS87`;

/**
 * What `xcodebuild archive` produced on its own: a *Development* identity from a
 * different team. ARCHIVE SUCCEEDED, and unusable for distribution.
 */
const IPA_DEV_SIGNED = `Identifier=ai.ompctl.app
Format=app bundle with Mach-O thin (arm64)
Authority=Apple Development: Jason Waldrip (LY77W79566)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=LY77W79566`;

/**
 * A Development-signed build from the CORRECT team. Needed to test the leaf-only
 * rule in isolation: with IPA_DEV_SIGNED the team check also fails, so that
 * sample cannot tell a leaf check from a whole-chain search.
 */
const IPA_DEV_SAME_TEAM = `Identifier=ai.ompctl.app
Format=app bundle with Mach-O thin (arm64)
Authority=Apple Development: Jason Waldrip (8H7HVPHS87)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=8H7HVPHS87`;

/*
 * The macOS app straight out of the archive: correct identity, no hardened runtime.
 *
 * These two samples keep `ai.ompctl.macos` deliberately. They are verbatim
 * captures from the Developer ID build that first exposed the missing hardened
 * runtime, taken before iOS and macOS were unified under ai.ompctl.app. Rewriting
 * the identifier would make the "real captured output" claim false, and the
 * identifier is incidental to what these assert, which is the runtime flag.
 */
const MAC_NO_RUNTIME = `Identifier=ai.ompctl.macos
Format=app bundle with Mach-O universal (x86_64 arm64)
Authority=Developer ID Application: Jason Waldrip (8H7HVPHS87)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=8H7HVPHS87`;

/** The same app after re-signing with --options runtime. */
const MAC_RUNTIME = `Identifier=ai.ompctl.macos
CodeDirectory v=20500 size=20411 flags=0x10000(runtime) hashes=631+3 location=embedded
Authority=Developer ID Application: Jason Waldrip (8H7HVPHS87)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=8H7HVPHS87`;

const NOTARY_INVALID = `Waiting for processing to complete.
Current status: In Progress...
Current status: Invalid......Processing complete
  id: 7ef14906-ebf7-4b79-9c30-315dbb954f21
  status: Invalid`;

/**
 * A `--wait` run that ended without the final summary block, so the only
 * statuses are the progress lines. Ordering is load-bearing here: the first is
 * "In Progress" and the last is the verdict.
 */
const NOTARY_INTERRUPTED = `Waiting for processing to complete.
Current status: In Progress...
Current status: In Progress....
Current status: Invalid......`;

const NOTARY_ACCEPTED = `Waiting for processing to complete.
Current status: In Progress...
Current status: Accepted......Processing complete
  id: 5535d42e-3ecb-42a7-8d84-f5fccbde3807
  status: Accepted`;

const SPCTL_NOTARIZED = `/tmp/ompctl-macos-build/ompctl.pkg: accepted
source=Notarized Developer ID
origin=Developer ID Installer: Jason Waldrip (8H7HVPHS87)`;

/** Validly signed, never notarized. Gatekeeper may still accept it. */
const SPCTL_SIGNED_ONLY = `/tmp/ompctl-macos-build/ompctl.pkg: accepted
source=Developer ID
origin=Developer ID Installer: Jason Waldrip (8H7HVPHS87)`;

/**
 * Real output for a Developer ID-signed package that was never submitted. Note
 * the wording: "Unnotarized" contains the substring "notarized", so a check
 * written as /notarized/i would accept the one artifact this function exists to
 * reject. `pkgutil --check-signature` calls this package "signed by a developer
 * certificate issued by Apple for distribution", which is why the signature check
 * alone is not the shipping gate.
 */
const SPCTL_UNNOTARIZED = `/tmp/unnotarized.pkg: rejected
source=Unnotarized Developer ID
origin=Developer ID Installer: Jason Waldrip (8H7HVPHS87)`;

describe("hardened runtime", () => {
  test("detects the flag when present", () => {
    expect(parseCodesignFlags(MAC_RUNTIME)).toBe(CS_RUNTIME);
    expect(hasHardenedRuntime(MAC_RUNTIME)).toBe(true);
  });

  test("reports absent when codesign printed no flags field", () => {
    // This is the artifact the notary service rejected. codesign --verify passed
    // on it, so absence of the field has to read as a failure, not as unknown.
    expect(parseCodesignFlags(MAC_NO_RUNTIME)).toBeNull();
    expect(hasHardenedRuntime(MAC_NO_RUNTIME)).toBe(false);
  });

  test("reports absent for an explicit zero flags field", () => {
    expect(hasHardenedRuntime("flags=0x0(none)")).toBe(false);
  });

  test("accepts runtime combined with other flags", () => {
    // Real signatures carry library-validation and similar bits alongside it.
    expect(hasHardenedRuntime("flags=0x10800(runtime,library-validation)")).toBe(true);
  });
});

describe("field parsing", () => {
  test("reads authorities outermost first", () => {
    expect(parseAuthorities(IPA_GOOD)[0]).toBe("Apple Distribution: Jason Waldrip (8H7HVPHS87)");
    expect(parseAuthorities(IPA_GOOD)).toHaveLength(3);
  });

  test("reads team and bundle id", () => {
    expect(parseTeamIdentifier(IPA_GOOD)).toBe(TEAM_ID);
    expect(parseBundleIdentifier(IPA_GOOD)).toBe("ai.ompctl.app");
  });

  test("returns null rather than guessing on unsigned output", () => {
    expect(parseAuthorities("code object is not signed at all")).toEqual([]);
    expect(parseTeamIdentifier("code object is not signed at all")).toBeNull();
  });
});

describe("verifySigning for the App Store", () => {
  const expectStore = {
    leafPrefix: "Apple Distribution",
    bundleId: "ai.ompctl.app",
  };

  test("passes the real exported ipa", () => {
    expect(verifySigning(IPA_GOOD, expectStore)).toEqual({ ok: true, problems: [] });
  });

  test("rejects the Development-signed archive on identity AND team", () => {
    // The defect that shipped silently: a valid Apple chain, wrong leaf, wrong team.
    const v = verifySigning(IPA_DEV_SIGNED, expectStore);
    expect(v.ok).toBe(false);
    expect(v.problems.some(p => p.includes("Apple Development"))).toBe(true);
    // Asserted on the team problem specifically. Matching the bare team id would
    // also match the leaf-authority message, which mentions it in passing, and
    // would still pass with the team check deleted.
    expect(v.problems.some(p => p.startsWith("TeamIdentifier is LY77W79566"))).toBe(true);
  });

  test("does not pass by finding a plausible authority further down the chain", () => {
    // A Development build still chains through WWDR and Apple Root CA, so a
    // whole-chain substring search would accept it. Only the leaf counts.
    //
    // This uses the same-team sample deliberately: with a wrong-team sample the
    // team check fails too, so the verdict would be false either way and the test
    // could not distinguish a leaf check from a chain search.
    const v = verifySigning(IPA_DEV_SAME_TEAM, { leafPrefix: "Apple Worldwide Developer Relations" });
    expect(v.ok).toBe(false);
    expect(v.problems.some(p => p.includes("leaf authority"))).toBe(true);
  });

  test("rejects a mismatched bundle id", () => {
    const v = verifySigning(IPA_GOOD, { ...expectStore, bundleId: "ai.ompctl.other" });
    expect(v.ok).toBe(false);
    expect(v.problems.some(p => p.includes("ai.ompctl.other"))).toBe(true);
  });

  test("rejects unsigned output", () => {
    const v = verifySigning("code object is not signed at all", expectStore);
    expect(v.ok).toBe(false);
    expect(v.problems.some(p => p.includes("unsigned"))).toBe(true);
  });
});

describe("verifySigning for notarization", () => {
  const expectNotarizable = {
    leafPrefix: "Developer ID Application",
    bundleId: "ai.ompctl.macos",
    requireHardenedRuntime: true,
  };

  test("rejects exactly the artifact Apple rejected", () => {
    const v = verifySigning(MAC_NO_RUNTIME, expectNotarizable);
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain("hardened runtime");
    // The message should say what will happen, not just what is missing.
    expect(v.problems[0]).toContain("notary");
  });

  test("passes the re-signed artifact Apple accepted", () => {
    expect(verifySigning(MAC_RUNTIME, expectNotarizable)).toEqual({ ok: true, problems: [] });
  });

  test("still requires the runtime when the identity is right", () => {
    // Guards against a future edit that only checks identity.
    expect(verifySigning(MAC_NO_RUNTIME, { leafPrefix: "Developer ID Application" }).ok).toBe(true);
    expect(verifySigning(MAC_NO_RUNTIME, expectNotarizable).ok).toBe(false);
  });
});

describe("notary status", () => {
  test("reads Accepted", () => {
    expect(parseNotaryStatus(NOTARY_ACCEPTED)).toBe("Accepted");
    expect(notaryAccepted(NOTARY_ACCEPTED)).toBe(true);
  });

  test("reads Invalid from a run that exited 0", () => {
    // notarytool exits 0 for a rejected submission it tracked successfully, so
    // the exit code cannot be the signal.
    expect(parseNotaryStatus(NOTARY_INVALID)).toBe("Invalid");
    expect(notaryAccepted(NOTARY_INVALID)).toBe(false);
  });

  test("takes the final status, not the first", () => {
    // NOTARY_INVALID carries exactly one `status:` field, so it cannot detect an
    // ordering mistake. This sample's only statuses are progress lines, where the
    // first is "In Progress" and the last is the verdict.
    expect(parseNotaryStatus(NOTARY_INTERRUPTED)).toBe("Invalid");
    expect(notaryAccepted(NOTARY_INTERRUPTED)).toBe(false);
  });

  test("extracts the submission id for log retrieval", () => {
    expect(parseSubmissionId(NOTARY_INVALID)).toBe("7ef14906-ebf7-4b79-9c30-315dbb954f21");
  });

  test("returns null on output with no status at all", () => {
    expect(parseNotaryStatus("could not connect to the notary service")).toBeNull();
    expect(notaryAccepted("could not connect to the notary service")).toBe(false);
  });
});

describe("gatekeeper and stapling", () => {
  test("accepts a notarized package", () => {
    expect(gatekeeperNotarized(SPCTL_NOTARIZED)).toBe(true);
  });

  test("rejects a signed-but-not-notarized package that Gatekeeper accepted", () => {
    // "accepted" alone is the weak signal; the notarized source is the claim.
    expect(gatekeeperNotarized(SPCTL_SIGNED_ONLY)).toBe(false);
  });

  test("rejects an outright rejection", () => {
    expect(gatekeeperNotarized("pkg: rejected\nsource=no usable signature")).toBe(false);
  });

  test("rejects the real 'Unnotarized Developer ID' verdict", () => {
    // The trap: this string contains "notarized". A case-insensitive substring
    // check would pass the exact artifact that must not ship.
    expect(gatekeeperNotarized(SPCTL_UNNOTARIZED)).toBe(false);
  });

  test("reads stapler success and failure", () => {
    expect(stapleValid("Processing: ompctl.pkg\nThe staple and validate action worked!")).toBe(true);
    expect(stapleValid("Processing: ompctl.pkg\nThe validate action worked!")).toBe(true);
    expect(stapleValid("Processing: ompctl.pkg\nError: A ticket was not found")).toBe(false);
  });
});

describe("store build entitlements", () => {
  test("a store profile does not permit debugging", () => {
    expect(profileIsStoreBuild({ "get-task-allow": false })).toBe(true);
    expect(profileIsStoreBuild({})).toBe(true);
  });

  test("a development profile does", () => {
    expect(profileIsStoreBuild({ "get-task-allow": true })).toBe(false);
  });
});
