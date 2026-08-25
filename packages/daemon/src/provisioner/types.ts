/**
 * Provisioner contracts.
 *
 * Every backend hands the supervisor the same thing: a duplex stream carrying
 * ACP JSON-RPC. Local is a pipe, container is `exec -i`, cloud is ssh. That is
 * why `HostHandle.spawn` returns a `LocalHost` whatever the transport -- the
 * supervisor stays transport-agnostic, and `spawnLocalHost` keeps ownership of
 * the approval-gate overlay in all three cases.
 */

import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import type { Actor, HostKind, HostRef, HostSpec } from "@ompd/core";
import type { GuestModelAccess } from "./guest-config.ts";

/**
 * Provisioning failed, or a host was asked to do something it cannot.
 *
 * Distinct from a generic Error so callers can tell "this host kind is not
 * available here" from a bug. The provisioner never degrades a failed
 * container or cloud provision into a local host: an agent the operator
 * believes is sandboxed, silently running on the laptop instead, is the exact
 * failure this type exists to make loud.
 */
export class ProvisionError extends Error {
  /** Host kind the caller asked for. A string, because it may be unknown. */
  readonly kind: string;

  constructor(message: string, kind = "unknown", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProvisionError";
    this.kind = kind;
  }
}

export interface HostHandle {
  ref: HostRef;
  /**
   * Open an ACP connection to this host.
   *
   * Always routed through `spawnLocalHost`, including for remote backends, so
   * the gate overlay is written and passed by the same code every time.
   */
  spawn(opts: SpawnLocalHostOptions): LocalHost;
}

export interface Provisioner {
  /** `actor` is optional: routines and the TTL sweep provision unattended. */
  provision(spec: HostSpec, actor?: Actor): Promise<HostHandle>;
  destroy(id: string, actor?: Actor): Promise<void>;
  list(): Promise<HostHandle[]>;
}

/** One host kind. The provisioner dispatches to exactly one of these, or fails. */
export interface ProvisionerBackend {
  readonly kind: HostKind;
  provision(spec: HostSpec): Promise<HostHandle>;
  destroy(handle: HostHandle): Promise<void>;
}

/**
 * How, if at all, a guest on a container network can reach a listener on this
 * host.
 *
 * A discriminated union rather than a nullable gateway/CIDR pair, because the
 * pair could not tell three different situations apart and the difference
 * decides both where the broker binds and whether a security check is
 * available. A null gateway meant "sealed network", "runtime spells its
 * `network inspect` output differently", and "the gateway exists but lives
 * inside a VM" all at once, and the only safe response to that ambiguity was
 * to refuse every runtime that was not Apple's.
 *
 * Which shape applies is a property of the runtime AND the host platform
 * together. That is a different claim from the one `runtime.ts` refuses to
 * make: confinement flags are not derivable from a runtime's name, so they are
 * read off `run --help`. No `--help` text says whether this binary's bridge
 * lives in a virtual machine. Docker Desktop on macOS and docker on Linux are
 * the same CLI with the same flags and the same `network inspect` shape, and
 * only one of them puts the gateway on a host interface.
 */
export type GuestBridge =
  | {
      /**
       * The bridge gateway is a real address on this host.
       *
       * Apple `container` on darwin, docker on Linux, rootful podman on Linux.
       * The broker binds `gateway` directly and the guest reaches it there.
       *
       * Peers arrive un-NAT'd, so their source address is inside `cidr` and a
       * peer-address check is meaningful. Enforcement is available on this
       * shape and only on this shape.
       */
      kind: "host-bridge";
      /** Bind target and the address the guest's endpoint names. Never a wildcard. */
      gateway: string;
      /** The network's own subnet, for the peer-address check. */
      cidr: string;
    }
  | {
      /**
       * The bridge gateway is inside the runtime's own virtual machine, but the
       * guest can reach this host by a name the runtime injects.
       *
       * Docker Desktop on macOS and Windows. The broker binds `bindHost` and
       * the guest's endpoint must name `hostname` instead: the two differ, and
       * seeding the bind address into the guest config would produce a
       * container that cannot reach its own broker.
       *
       * The peer-address check is NOT available here. Requests arrive NAT'd
       * through the VM, so their source address says nothing about which
       * container sent them. This shape exists to say that out loud rather
       * than let a caller pass a permissive CIDR that is indistinguishable,
       * inside the broker, from one misread out of `network inspect`.
       *
       * It also widens who can reach the broker: a loopback listener is
       * reachable by every local process and user on the machine, where a
       * bridge listener was reachable only from that one container network.
       * What still bounds it is the bearer, the single allowlisted model and
       * the request ceilings.
       */
      kind: "host-alias";
      /** Name the guest resolves to this host, e.g. `host.docker.internal`. */
      hostname: string;
      /** Loopback address to bind. Never a wildcard, and never a routable address. */
      bindHost: string;
    }
  | {
      /**
       * No host-reachable address could be established, so model access cannot
       * be provisioned on this runtime and platform.
       *
       * A first-class answer rather than an error, because the provider is
       * what turns it into a refusal and the audit row. `reason` is the entire
       * text an operator sees when provisioning refuses, so it names the
       * runtime and reads as an instruction.
       */
      kind: "unsupported";
      reason: string;
    };

/**
 * How a provisioned container gets model access, and how it loses it again.
 *
 * This is the seam between the container backend and the daemon's model
 * broker, and it exists so `container.ts` never learns what a broker is. The
 * backend knows the facts the broker cannot discover for itself -- the network
 * it just created and how a guest on it can reach this host -- and the broker
 * knows the one fact the backend must not hold, which is how to reach the
 * operator's credential. Neither imports the other.
 *
 * The three calls are separate because the measured ordering forces them to
 * be. `network inspect` reports the gateway immediately after `network
 * create`, but BINDING that gateway address only succeeds while a container is
 * running on the network -- otherwise `bind()` fails `EADDRNOTAVAIL`. The
 * guest's config has to name the endpoint before the container starts, so the
 * address is granted first and bound afterwards.
 *
 * `grant` returning `null` means "no model access is configured", and the
 * backend treats that exactly like a throw: it fails the provision. A
 * container agent that reaches `idle` and then fails every prompt with "No
 * model selected" is the defect this whole seam exists to remove, so there is
 * no path here that provisions one anyway.
 *
 * Nothing in this interface may put the granted bearer anywhere but the guest's
 * own 0600 token file. `release` takes it because revocation needs to name the
 * grant, and the backend holds it in memory only: it is deliberately absent
 * from `HostRef.resolved`, which the store persists.
 */
export interface ModelAccessProvider {
  /**
   * Mint access for a container that does not exist yet.
   *
   * Called after `network create` and before `container run`. `bridge` already
   * carries the verdict, including `unsupported` with a reason written for an
   * operator; the implementation decides what it can serve and refuses the
   * rest. The backend only knows that a `null` result or a throw ends the
   * provision.
   */
  grant(input: { network: string | null; bridge: GuestBridge }): Promise<GuestModelAccess | null>;
  /**
   * Bind the granted endpoint, now that the container is running.
   *
   * Separate from `grant` for one measured reason: the bridge address does not
   * exist until a container is attached to the network. A throw here is fatal
   * to the provision, because the guest has already been handed an endpoint
   * that nothing is listening on.
   *
   * Receives the same `bridge` value `grant` did, so the implementation binds
   * what it planned to bind rather than re-deriving it.
   */
  activate(input: { bridge: GuestBridge }): Promise<void>;
  /** Revoke a grant on teardown. Must be safe for a token the provider has already forgotten. */
  release(input: { token: string }): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
}

/**
 * Every subprocess the provisioner runs goes through this seam, so tests never
 * touch a container runtime or the network.
 */
export type CommandRunner = (argv: string[], opts?: CommandOptions) => Promise<CommandResult>;

/** The host-factory seam, matching `SupervisorOptions.spawnHost`. */
export type SpawnHost = (opts: SpawnLocalHostOptions) => LocalHost;
