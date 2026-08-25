/**
 * The one validator for an untrusted host spec.
 *
 * It lives here, in core, because there is more than one door. It began in the
 * gateway, where `POST /v1/agents` and the `agent_create` frame both reach it,
 * and a security review then found a third: `QueuedIntentDrainer`'s federation
 * replay had its own `parseHostSpec` and `parseMounts`, written before any of
 * these controls existed and never revisited, while the file's own comment
 * claimed the payload was revalidated. What that second parser actually did,
 * all of it reachable once `intentPeerUrl` and its token are configured:
 *
 *   - copied any string `image` straight through, so every supply-chain control
 *     on the default path (a digest-pinned base, a reviewed omp binary, a
 *     verified CA bundle) was bypassed by replaying an intent that named one,
 *     and the approval gate could not mitigate it because a generic OCI image's
 *     ENTRYPOINT runs before ompd has a process to gate
 *   - dropped `network`, so a `"none"` intent replayed as `isolated` with open
 *     egress and no error anywhere
 *   - required a `containerPath` that `HostMount` has not had for some time, so
 *     a current `{ hostPath, mode }` mount was REFUSED, while the legacy shape
 *     it did accept silently discarded `mode` and turned an `rw` mount into the
 *     default
 *   - dropped `ref` and `ttlSeconds`
 *
 * Two validators for one trust boundary is the defect, not the specific bugs in
 * the second one. A door that is added later, or a parser that is left behind
 * when the shape changes, is the shape this file exists to prevent: there is
 * one function, every caller uses it, and adding a field means adding it here.
 *
 * It is pure on purpose, taking `unknown` and returning either a value or a
 * reason. That is what lets three callers with three different error surfaces (a
 * 400 body, a socket frame, a thrown intent failure) share the decision without
 * sharing anything else, and it is why this is in core rather than exported
 * from the gateway: importing a gateway internal into the federation drainer
 * would couple two subsystems that have no other reason to know about each
 * other.
 */

import { type HostKind, type HostMount, isRecord, type WireHostSpec } from "./contracts.ts";

/**
 * Fields a client may put in a `host`. Anything else is a refusal, not a
 * pass-through.
 *
 * `image` is deliberately absent, and is refused by name below rather than
 * falling out of this table as an unknown field, because the reason matters
 * more than the refusal.
 */
const HOST_SPEC_KEYS: Record<string, true> = {
  kind: true,
  repo: true,
  ref: true,
  ttlSeconds: true,
  mounts: true,
  network: true,
};

/** Fields a client may put in a `host.mounts` entry. */
const HOST_MOUNT_KEYS: Record<string, true> = { hostPath: true, mode: true };

/**
 * The refusal `host.image` gets, spelled out because a bare "unknown field"
 * would send someone looking for a typo instead of for the daemon's config.
 */
export const WIRE_IMAGE_REFUSAL =
  "host.image is not accepted from a paired device. Naming a container image is daemon-local supply-chain " +
  "approval, and a device holding manage scope is not that: the image's ENTRYPOINT is the first thing the " +
  'runtime executes, before ompd has a process to gate, so no approval can confine it. Set "containerImage" ' +
  "in the daemon's config.json instead, on the machine that will run it. Omitting host.image uses ompd's " +
  "digest-pinned default base plus its mounted toolchain, which is the remote path.";

export type WireHostSpecResult = { host: WireHostSpec } | { error: string };

/**
 * Narrows an untrusted `host` into a `WireHostSpec`, or says why it is not one.
 *
 * This replaces an `as HostSpec` cast at the gateway and a hand-written parser
 * in the federation drainer. In both places the check was the declaration:
 * whatever the caller put in `host` reached the provisioner with its declared
 * type and none of its claims tested, and the provisioner puts those fields
 * into a runtime's argv.
 *
 * `image` is not a field a remote caller may set, at all. It was once accepted
 * with a leading-dash check in front of it, which was the wrong shape of
 * defence: the dash check stopped a value the runtime would read as a flag, and
 * did nothing about the actual problem, which is that any other image bypasses
 * the entire pinned supply chain.
 *
 * The return type is `WireHostSpec`, not `HostSpec`, so a later change cannot
 * re-open this by handing a wire value to something that sets `image`: the
 * widening direction typechecks and the narrowing one does not. Note that a
 * bare `Omit<HostSpec, "image">` would NOT have that property, because omitting
 * an optional field leaves the two types mutually assignable; see the type's
 * own definition for how it is actually made one-way.
 *
 * Every accepted field is copied onto a fresh object rather than the input
 * being cast. Rejecting unknown keys already refuses an extra field, so the
 * copy is belt and braces, but it means nothing a caller sends can reach the
 * provisioner by a route this function did not walk.
 *
 * Mount paths are deliberately NOT resolved here. That is `resolveMountPath`'s
 * job, called where the daemon's own `home` is known and the canonical path
 * goes straight into argv; a validator that pre-resolved would be a second,
 * weaker copy of that decision. What this does guarantee is the shape, so the
 * canonicalizing caller is never handed a mount it cannot read.
 */
export function validateWireHostSpec(value: unknown): WireHostSpecResult {
  if (!isRecord(value)) return { error: "host must be an object" };
  // Ahead of the unknown-key sweep, so the answer names the trust boundary
  // rather than reading as a spelling mistake. `in` rather than a defined
  // check: `{ image: undefined }` is still a caller asking for the field.
  if ("image" in value) return { error: WIRE_IMAGE_REFUSAL };
  const unknownKey = Object.keys(value).find(key => HOST_SPEC_KEYS[key] !== true);
  if (unknownKey !== undefined) return { error: `host has an unknown field "${unknownKey}"` };
  // Narrowed by comparison rather than by a guard function, so `value.kind`
  // reaches the fresh object as a `HostKind` with nothing asserted.
  if (value.kind !== "local" && value.kind !== "container" && value.kind !== "cloud") {
    return { error: "host.kind must be one of local, container, cloud" };
  }

  const kind: HostKind = value.kind;
  const host: WireHostSpec = { kind };

  if (value.repo !== undefined) {
    if (typeof value.repo !== "string") return { error: "host.repo must be a string" };
    host.repo = value.repo;
  }
  if (value.ref !== undefined) {
    if (typeof value.ref !== "string") return { error: "host.ref must be a string" };
    host.ref = value.ref;
  }
  if (value.ttlSeconds !== undefined) {
    // A zero or negative TTL is an immediate self-destruct dressed as a
    // lifetime, and NaN or Infinity reaches a timer as neither.
    if (typeof value.ttlSeconds !== "number" || !Number.isFinite(value.ttlSeconds) || value.ttlSeconds <= 0) {
      return { error: "host.ttlSeconds must be a positive finite number" };
    }
    host.ttlSeconds = value.ttlSeconds;
  }
  if (value.network !== undefined) {
    if (value.network !== "isolated" && value.network !== "none") {
      return { error: 'host.network must be "isolated" or "none"' };
    }
    // Refused for a local host rather than accepted and ignored. `LocalBackend`
    // spawns a process on the daemon's own machine, which has no network
    // namespace of its own to isolate or remove, so a caller who asked for
    // `"none"` and got a `local` host would have been told yes and given a
    // process with the operator's full network. The refusal belongs here
    // rather than in the backend: it is a property of the request, and putting
    // it in one backend would mean every other backend has to grow the same
    // opinion separately.
    if (kind === "local") {
      return {
        error:
          "host.network cannot be set on a local host: it runs as a process on the daemon's own machine and has " +
          "no network of its own to isolate or remove, so ompd will not accept a confinement it cannot apply. Ask " +
          'for kind: "container" if the network is what matters.',
      };
    }
    host.network = value.network;
  }
  if (value.mounts !== undefined) {
    if (!Array.isArray(value.mounts)) return { error: "host.mounts must be an array" };
    const mounts: HostMount[] = [];
    for (const entry of value.mounts) {
      if (!isRecord(entry)) return { error: "each host.mounts entry must be an object" };
      const unknownMountKey = Object.keys(entry).find(key => HOST_MOUNT_KEYS[key] !== true);
      if (unknownMountKey !== undefined) {
        return { error: `a host.mounts entry has an unknown field "${unknownMountKey}"` };
      }
      if (typeof entry.hostPath !== "string" || entry.hostPath.length === 0) {
        return { error: "each host.mounts entry needs a non-empty hostPath string" };
      }
      if (entry.mode !== undefined && entry.mode !== "ro" && entry.mode !== "rw") {
        return { error: 'a host.mounts mode must be "ro" or "rw"' };
      }
      mounts.push(
        entry.mode === undefined ? { hostPath: entry.hostPath } : { hostPath: entry.hostPath, mode: entry.mode },
      );
    }
    host.mounts = mounts;
  }

  return { host };
}
