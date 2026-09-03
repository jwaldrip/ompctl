/**
 * Host reuse is a security decision, not a cache.
 *
 * `Supervisor.#hostFor` answers "may this request be served by a host that
 * already exists?", and every field it forgets to compare is a way for a
 * caller to be handed something other than what they asked for. The merged
 * comparison compared four fields (`image`, `repo`, `ref`, `ttlSeconds`) and
 * silently omitted the two that describe confinement, which produced two real
 * bypasses:
 *
 * 1. A `network: "none"` request was served by an existing isolated (NAT)
 *    host. `ContainerBackend.provision` is the only thing that refuses a
 *    "none" policy on a runtime that cannot express one, and reuse jumps over
 *    provisioning entirely, so the caller got open egress with no error at
 *    all. The refusal was not weakened; it was made unreachable.
 *
 * 2. A request naming a new mount was served by a host that did not have it.
 *    `resolveMountPath` runs inside `provision`, so on the reuse path the
 *    operator's path was never canonicalized and never policy-checked. Two
 *    outcomes, both silent: an agent missing the directory it asked for, or
 *    (with the host reused in the other direction) an agent holding a mount
 *    the current request never named.
 *
 * Both were reachable with no error, which is why "it worked in testing" was
 * true and useless. Each is proved here twice: once against the merged
 * comparison, reproduced verbatim as `mergedReuseMatches` below, and once
 * against the current supervisor, so the test says what changed rather than
 * only that something passes now.
 *
 * The merged comparison is reproduced as a fixture rather than imported from
 * `1efcdd4`. Importing it would mean loading a second copy of a 1400-line
 * module compiled against today's `@ompd/core`, for four lines of boolean; the
 * fixture is those four lines, and the header comment above it cites the
 * commit so it can be diffed by hand.
 *
 * Portability: every real directory here comes from `mkdtempSync` plus
 * `realpathSync`, and no assertion names `/private` or a `/var/folders`
 * layout. `/etc` canonicalizes to `/private/etc` on macOS and to itself on
 * Linux, so the refusal assertions match on the substrings both spellings
 * share. Linux CI runs as root, so nothing here depends on a directory being
 * unreadable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type HostSpec, SCOPE_MANAGE, Store } from "@ompd/core";
import type { HostHandle, Provisioner, SpawnHost } from "../src/provisioner/types.ts";
import { ProvisionError } from "../src/provisioner/types.ts";
import {
  HOST_SPEC_REUSE_KEYS,
  hostReuseKey,
  type NormalizedHostSpec,
  normalizeHostSpec,
  Supervisor,
} from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

/**
 * The merged reuse comparison, verbatim, from `1efcdd4`
 * `packages/daemon/src/supervisor.ts` around line 1027:
 *
 * ```ts
 * if (entry.spec.kind !== spec.kind) continue;
 * if (!entry.host.client.agentInfo || entry.agents.size >= 16) continue;
 * if (
 *   spec.kind !== "local" &&
 *   (entry.spec.image !== spec.image ||
 *     entry.spec.repo !== spec.repo ||
 *     entry.spec.ref !== spec.ref ||
 *     entry.spec.ttlSeconds !== spec.ttlSeconds)
 * ) {
 *   continue;
 * }
 * return entry;
 * ```
 *
 * The liveness and headroom checks are dropped because they are unchanged and
 * are not what the bypasses turn on. What is left is the whole of the old
 * spec comparison: `true` means "this request was served by that host".
 */
function mergedReuseMatches(entrySpec: HostSpec, spec: HostSpec): boolean {
  if (entrySpec.kind !== spec.kind) return false;
  if (
    spec.kind !== "local" &&
    (entrySpec.image !== spec.image ||
      entrySpec.repo !== spec.repo ||
      entrySpec.ref !== spec.ref ||
      entrySpec.ttlSeconds !== spec.ttlSeconds)
  ) {
    return false;
  }
  return true;
}

const stores: Store[] = [];
const sups: Supervisor[] = [];
const scratch: string[] = [];

afterEach(async () => {
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (scratch.length) rmSync(scratch.pop() ?? "", { recursive: true, force: true });
});

/** A real, canonical directory that exists, so `mustExist` is satisfied. */
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

interface RecordedProvisioner extends Provisioner {
  /** Every `provision` call, including the ones that then threw. */
  calls: HostSpec[];
  /** Stand in for `ContainerBackend`'s refusal on a runtime with no `none` network. */
  refuseNetworkNone: boolean;
}

function recordingProvisioner(spawn: SpawnHost): RecordedProvisioner {
  let next = 1;
  const provisioner: RecordedProvisioner = {
    calls: [],
    refuseNetworkNone: false,
    provision: async (spec: HostSpec): Promise<HostHandle> => {
      provisioner.calls.push(spec);
      if (provisioner.refuseNetworkNone && spec.network === "none") {
        // Worded like the real one so a test asserting on it is asserting on
        // the provider's refusal being REACHED, not on this fake's prose.
        throw new ProvisionError("cannot express a container with no network", spec.kind);
      }
      const id = `cnt_${next++}`;
      return { ref: { kind: spec.kind, id, spec }, spawn };
    },
    destroy: async () => {},
    list: async () => [],
  };
  return provisioner;
}

interface Harness {
  sup: Supervisor;
  provisioner: RecordedProvisioner;
  actor: Actor;
}

function harness(opts: { home?: string } = {}): Harness {
  const dir = scratchDir("ompd-reuse-db-");
  const store = new Store(join(dir, "ompd.db"));
  stores.push(store);
  store.addDevice({
    id: "operator",
    name: "operator",
    publicKey: "pk_operator",
    scopes: [SCOPE_MANAGE],
    createdAt: new Date().toISOString(),
  });
  const fake = createFakeHost();
  const provisioner = recordingProvisioner(fake.factory);
  const home = opts.home ?? scratchDir("ompd-reuse-home-");
  const sup = new Supervisor({ store, spawnHost: fake.factory, provisioner, home });
  sups.push(sup);
  return { sup, provisioner, actor: { deviceId: "operator", scopes: [SCOPE_MANAGE] } };
}

const CWD = "/tmp";

async function create(h: Harness, name: string, host: HostSpec): Promise<void> {
  await h.sup.createAgent({ name, cwd: CWD, host }, h.actor);
}

describe("bypass 1: a network:none request reusing an isolated host", () => {
  test("the merged comparison reused the isolated host, so the provider refusal was unreachable", () => {
    // Both specs are containers with no image, repo, ref or ttl, so all four
    // fields the merged code compared are equal and it answered "reuse". The
    // only difference between them is the one thing it never looked at.
    const isolated: HostSpec = { kind: "container" };
    const sealed: HostSpec = { kind: "container", network: "none" };

    expect(mergedReuseMatches(isolated, sealed)).toBe(true);

    // The fix: the same pair, normalized, are two different hosts.
    const home = scratchDir("ompd-reuse-home-");
    expect(hostReuseKey(normalizeHostSpec(isolated, home))).not.toBe(hostReuseKey(normalizeHostSpec(sealed, home)));
  });

  test("the supervisor now provisions, so the provider's refusal is what answers", async () => {
    const h = harness();
    h.provisioner.refuseNetworkNone = true;

    // An isolated container host, live and with headroom, for the same cwd.
    await create(h, "isolated", { kind: "container" });
    expect(h.provisioner.calls).toHaveLength(1);

    // Under the merged comparison this call returned the host above and never
    // touched the provisioner: no refusal, no error, open egress.
    await expect(create(h, "sealed", { kind: "container", network: "none" })).rejects.toThrow(
      /cannot express a container with no network/,
    );

    // The refusal came from the provider, which means the provider was asked.
    expect(h.provisioner.calls).toHaveLength(2);
    expect(h.provisioner.calls[1]?.network).toBe("none");
  });

  test("a runtime that can express it gets a second host rather than the isolated one", async () => {
    const h = harness();
    await create(h, "isolated", { kind: "container" });
    await create(h, "sealed", { kind: "container", network: "none" });

    // Two provisions, and the second carries the policy the caller asked for.
    // A single call here would mean the sealed agent is running on the NAT
    // host, which is the bypass wearing a passing test.
    expect(h.provisioner.calls).toHaveLength(2);
    expect(h.provisioner.calls[0]?.network).toBe("isolated");
    expect(h.provisioner.calls[1]?.network).toBe("none");
  });
});

describe("bypass 2: mounts never validated on the reuse path", () => {
  test("the merged comparison reused the host, so /etc was never canonicalized or checked", () => {
    const plain: HostSpec = { kind: "container" };
    const dangerous: HostSpec = { kind: "container", mounts: [{ hostPath: "/etc" }] };

    // No error, no canonicalization, no policy check: just the existing host.
    expect(mergedReuseMatches(plain, dangerous)).toBe(true);

    // The fix refuses before any lookup happens.
    const home = scratchDir("ompd-reuse-home-");
    expect(() => normalizeHostSpec(dangerous, home)).toThrow(/refusing to mount \/etc/);
  });

  test("a dangerous mount is refused identically whether or not a host exists", async () => {
    const fresh = harness();
    const withHost = harness();
    await create(withHost, "first", { kind: "container" });
    expect(withHost.provisioner.calls).toHaveLength(1);

    const dangerous: HostSpec = { kind: "container", mounts: [{ hostPath: "/etc" }] };
    const reasons: string[] = [];
    for (const h of [fresh, withHost]) {
      const error = await create(h, "danger", dangerous).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProvisionError);
      reasons.push(error instanceof Error ? error.message : String(error));
    }

    // Identical, which is the property: a caller cannot tell from the refusal
    // whether a host happened to exist, because the answer does not depend on
    // it. `/etc` reads as `/private/etc` on macOS and as itself on Linux, so
    // the assertion names neither spelling.
    expect(reasons[0]).toBe(reasons[1] ?? "");
    expect(reasons[0]).toMatch(/refusing to mount \/etc/);
    expect(reasons[0]).toMatch(/protected directory/);

    // And the refusal happened before provisioning, on both.
    expect(fresh.provisioner.calls).toHaveLength(0);
    expect(withHost.provisioner.calls).toHaveLength(1);
  });

  test("a legitimate new mount forces a new host instead of being silently dropped", async () => {
    const h = harness();
    const data = scratchDir("ompd-reuse-data-");

    await create(h, "plain", { kind: "container" });
    await create(h, "mounted", { kind: "container", mounts: [{ hostPath: data }] });

    expect(h.provisioner.calls).toHaveLength(2);
    // The agent that asked for the directory got a host that has it, with the
    // canonical path and the documented default mode filled in.
    expect(h.provisioner.calls[1]?.mounts).toEqual([{ hostPath: data, mode: "ro" }]);
    // And the first host was not retroactively given anything.
    expect(h.provisioner.calls[0]?.mounts).toEqual([]);
  });

  test("a host is never inherited by a request that drops one of its mounts", async () => {
    const h = harness();
    const data = scratchDir("ompd-reuse-data-");

    await create(h, "mounted", { kind: "container", mounts: [{ hostPath: data }] });
    // The dangerous direction: this caller named no mounts, and the merged
    // comparison would hand it the host holding one.
    await create(h, "plain", { kind: "container" });

    expect(h.provisioner.calls).toHaveLength(2);
    expect(h.provisioner.calls[1]?.mounts).toEqual([]);
  });

  test("the same directory under a different mode is a different host", async () => {
    const h = harness();
    const data = scratchDir("ompd-reuse-data-");

    await create(h, "ro", { kind: "container", mounts: [{ hostPath: data, mode: "ro" }] });
    await create(h, "rw", { kind: "container", mounts: [{ hostPath: data, mode: "rw" }] });

    expect(h.provisioner.calls).toHaveLength(2);
    expect(h.provisioner.calls[1]?.mounts).toEqual([{ hostPath: data, mode: "rw" }]);
  });
});

describe("normalization does not invent new hosts", () => {
  test("mount order is not part of the request", async () => {
    const h = harness();
    const a = scratchDir("ompd-reuse-a-");
    const b = scratchDir("ompd-reuse-b-");

    await create(h, "ab", { kind: "container", mounts: [{ hostPath: a }, { hostPath: b }] });
    await create(h, "ba", { kind: "container", mounts: [{ hostPath: b }, { hostPath: a }] });

    // One host. Splitting here would be the opposite failure from the one
    // being fixed, and just as invisible: two containers for one request.
    expect(h.provisioner.calls).toHaveLength(1);
  });

  test("an absent network policy and an explicit isolated are one spec", async () => {
    const h = harness();

    await create(h, "default", { kind: "container" });
    await create(h, "explicit", { kind: "container", network: "isolated" });

    expect(h.provisioner.calls).toHaveLength(1);
  });

  test("a symlink to a mounted directory is the same mount", async () => {
    const h = harness();
    const data = scratchDir("ompd-reuse-data-");
    const parent = scratchDir("ompd-reuse-link-");
    const link = join(parent, "alias");
    symlinkSync(data, link);

    // The alias goes FIRST on purpose. The host is provisioned from a caller
    // string that is not the directory's real name, so the assertions below
    // are about what was STORED rather than about what happened to be typed.
    await create(h, "aliased", { kind: "container", mounts: [{ hostPath: link }] });
    await create(h, "real", { kind: "container", mounts: [{ hostPath: data }] });

    // One host, and the canonical path is what the provisioner was handed:
    // had the caller's string survived, the runtime would resolve it again on
    // its own side, and the path that was judged would not be the path that
    // got mounted.
    expect(h.provisioner.calls).toHaveLength(1);
    expect(h.provisioner.calls[0]?.mounts).toEqual([{ hostPath: data, mode: "ro" }]);
  });

  test("two plain local agents still share one host", async () => {
    const h = harness();

    await create(h, "one", { kind: "local" });
    await create(h, "two", { kind: "local" });

    // Nothing was provisioned, and nothing split: a normalized local spec has
    // to compare equal to another normalized local spec, or every local agent
    // would get its own `omp acp` process.
    expect(h.provisioner.calls).toHaveLength(0);
    expect(h.sup.listAgents()).toHaveLength(2);
    const [first, second] = h.sup.listAgents();
    expect(first?.host.id).toBe(second?.host.id ?? "");
  });
});

describe("the reuse comparison names every field of HostSpec", () => {
  test("the key list matches the contract, field for field", () => {
    // The compiler already forces a new `HostSpec` field into
    // `HOST_SPEC_REUSE_FIELDS` (it is a `Record<keyof HostSpec, true>`). This
    // is the other half: it forces somebody to DECIDE what the new field means
    // for reuse, by failing here until this literal list is updated too.
    //
    // If this test fails after a contract change, do not just add the name.
    // Add a case to `reuseValue` and a test below proving two specs differing
    // only in that field are two hosts, or prove they are one.
    expect([...HOST_SPEC_REUSE_KEYS]).toEqual(["image", "kind", "mounts", "network", "ref", "repo", "ttlSeconds"]);
  });

  test("every named field actually changes the token", () => {
    const home = scratchDir("ompd-reuse-home-");
    const data = scratchDir("ompd-reuse-data-");
    const base: NormalizedHostSpec = normalizeHostSpec({ kind: "container" }, home);
    const baseline = hostReuseKey(base);

    // One variant per field, so a field listed but not wired into `reuseValue`
    // is caught here rather than by nothing. `kind` is covered by the local
    // case: a local and a container spec differ in nothing else.
    const variants: Record<string, HostSpec> = {
      image: { kind: "container", image: "ghcr.io/example/omp:1" },
      kind: { kind: "local" },
      mounts: { kind: "container", mounts: [{ hostPath: data }] },
      network: { kind: "container", network: "none" },
      ref: { kind: "container", ref: "main" },
      repo: { kind: "container", repo: "git@example.com:x/y.git" },
      ttlSeconds: { kind: "container", ttlSeconds: 60 },
    };

    for (const key of HOST_SPEC_REUSE_KEYS) {
      const variant = variants[key];
      expect(variant, `no variant covers HostSpec field ${key}`).toBeDefined();
      if (variant === undefined) continue;
      expect(hostReuseKey(normalizeHostSpec(variant, home)), `${key} does not affect reuse`).not.toBe(baseline);
    }
  });
});

describe("the supervisor uses the home it was given", () => {
  test("a mount inside that home is refused as the daemon's own state", async () => {
    const home = scratchDir("ompd-reuse-home-");
    const inside = join(home, "state");
    mkdirSync(inside);

    const h = harness({ home });
    const error = await create(h, "greedy", { kind: "container", mounts: [{ hostPath: inside }] }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ProvisionError);
    expect(error instanceof Error ? error.message : "").toMatch(/daemon's own state directory/);
    expect(h.provisioner.calls).toHaveLength(0);
  });

  test("the identical path is allowed to a supervisor whose home is elsewhere", async () => {
    // The other side of the same claim. Without this, the test above would
    // still pass if the path were being refused for some unrelated reason, and
    // it is the pair that proves the home is read from the option rather than
    // from `~/.ompd`. This is the regression guard for the daemon dropping
    // `home:` from its `new Supervisor({...})` call: nothing else would fail.
    const home = scratchDir("ompd-reuse-home-");
    const inside = join(home, "state");
    mkdirSync(inside);

    const h = harness({ home: scratchDir("ompd-reuse-elsewhere-") });
    await create(h, "neighbour", { kind: "container", mounts: [{ hostPath: inside }] });

    expect(h.provisioner.calls).toHaveLength(1);
    expect(h.provisioner.calls[0]?.mounts).toEqual([{ hostPath: inside, mode: "ro" }]);
  });
});
