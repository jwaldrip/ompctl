/**
 * Unit tests for capture-shots.ts redaction and provenance controls.
 *
 * Contaminated inputs below are synthetic test fixtures (e.g. "acme-corp", "client-alpha").
 * Never use or commit operator terms in test fixtures, which would fail the provenance sweep.
 */
import { describe, expect, test } from "bun:test";
import {
  BELIEVABLE_REPLACEMENTS,
  buildRedactionPairs,
  checkDomForLeaks,
  fnv1a,
  getProvenanceTerms,
} from "../packages/site/scripts/capture-shots.ts";

describe("fnv1a hash", () => {
  test("is deterministic across repeated calls", () => {
    expect(fnv1a("test-string")).toBe(fnv1a("test-string"));
    expect(fnv1a("another-term")).toBe(fnv1a("another-term"));
  });

  test("produces non-negative integers", () => {
    expect(fnv1a("alpha")).toBeGreaterThanOrEqual(0);
    expect(fnv1a("beta")).toBeGreaterThanOrEqual(0);
  });
});

describe("buildRedactionPairs", () => {
  const SYNTHETIC_TERMS = ["acme-holdings-international", "acme-holdings", "northwind-traders", "globex-telecom"];

  test("maps terms to believable synthetic replacements", () => {
    const pairs = buildRedactionPairs(SYNTHETIC_TERMS);
    expect(pairs.length).toBe(SYNTHETIC_TERMS.length);
    for (const [term, replacement] of pairs) {
      expect(SYNTHETIC_TERMS).toContain(term);
      expect(BELIEVABLE_REPLACEMENTS).toContain(replacement);
    }
  });

  test("is deterministic: same term always yields the same replacement", () => {
    const run1 = buildRedactionPairs(SYNTHETIC_TERMS);
    const run2 = buildRedactionPairs(SYNTHETIC_TERMS);
    expect(run1).toEqual(run2);
  });

  test("sorts pairs by descending term length to avoid sub-phrase clobbering", () => {
    const pairs = buildRedactionPairs(SYNTHETIC_TERMS);
    for (let i = 0; i < pairs.length - 1; i++) {
      expect(pairs[i]![0].length).toBeGreaterThanOrEqual(pairs[i + 1]![0].length);
    }
    // "acme-holdings-international" must come before "acme-holdings"
    const longIdx = pairs.findIndex(([t]) => t === "acme-holdings-international");
    const shortIdx = pairs.findIndex(([t]) => t === "acme-holdings");
    expect(longIdx).toBeLessThan(shortIdx);
  });

  test("assigns distinct replacements without duplicates when possible", () => {
    const pairs = buildRedactionPairs(SYNTHETIC_TERMS);
    const replacements = pairs.map(([, r]) => r);
    const unique = new Set(replacements);
    expect(unique.size).toBe(replacements.length);
  });
});

describe("checkDomForLeaks", () => {
  const TARGETS = {
    clientAndOrgNames: ["acme-corp", "globex"],
    sessionTitles: ["fix raft consensus"],
    directories: ["/users/dev/src/private-repo"],
  };

  test("detects client/org name leaks in DOM text", () => {
    const text = "Welcome to the Acme-Corp dashboard overview.";
    const leaks = checkDomForLeaks(text, TARGETS);
    expect(leaks).toContain("client/org:acme-corp");
  });

  test("detects session title leaks", () => {
    const text = "Active session: Fix Raft Consensus in progress";
    const leaks = checkDomForLeaks(text, TARGETS);
    expect(leaks).toContain("title:fix raft consensus");
  });

  test("detects private directory leaks", () => {
    const text = "Working directory: /Users/dev/src/private-repo/core";
    const leaks = checkDomForLeaks(text, TARGETS);
    expect(leaks).toContain("directory:/users/dev/src/private-repo");
  });

  test("reports zero leaks when DOM text contains only clean marketing copy", () => {
    const text = "Connected to edge-mesh running vector-engine on /workspace/project";
    const leaks = checkDomForLeaks(text, TARGETS);
    expect(leaks).toEqual([]);
  });

  test("detects unauthorized email addresses", () => {
    const text = "Contact operator at confidential@operator.internal for help.";
    const leaks = checkDomForLeaks(text, TARGETS);
    expect(leaks.some(l => l.startsWith("email:"))).toBe(true);
  });
});

describe("getProvenanceTerms", () => {
  test("parses newline and comma separated environment variables", () => {
    const orig = process.env.OMPCTL_PROVENANCE_TERMS;
    try {
      process.env.OMPCTL_PROVENANCE_TERMS = "client-one, client-two, client three\nclient-four";
      const parsed = getProvenanceTerms();
      expect(parsed).toEqual(["client-one", "client-two", "client three", "client-four"]);
    } finally {
      if (orig !== undefined) {
        process.env.OMPCTL_PROVENANCE_TERMS = orig;
      } else {
        delete process.env.OMPCTL_PROVENANCE_TERMS;
      }
    }
  });

  test("returns empty array when environment variable is unset", () => {
    const orig = process.env.OMPCTL_PROVENANCE_TERMS;
    const origFile = process.env.OMPCTL_PROVENANCE_TERMS_FILE;
    try {
      delete process.env.OMPCTL_PROVENANCE_TERMS;
      delete process.env.OMPCTL_PROVENANCE_TERMS_FILE;
      const parsed = getProvenanceTerms();
      expect(parsed).toEqual([]);
    } finally {
      if (orig !== undefined) process.env.OMPCTL_PROVENANCE_TERMS = orig;
      if (origFile !== undefined) process.env.OMPCTL_PROVENANCE_TERMS_FILE = origFile;
    }
  });
});
