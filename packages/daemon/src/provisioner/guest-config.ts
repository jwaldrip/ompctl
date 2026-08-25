/**
 * The guest's half of container model access.
 *
 * A container agent used to reach `idle` and then fail every prompt with
 * "No model selected", because the guest had no provider credential and no
 * selected model. Handing it a provider credential is not an option: the guest
 * has full unrestricted internet egress and Apple `container` rejects
 * `--cap-drop`, so anything reusable that reaches the guest can be taken off
 * this machine and the sandbox offers nothing to fall back on. So the guest
 * instead gets a scoped bearer for exactly one model on exactly one endpoint,
 * the daemon-owned broker, and this file writes the two config files and the
 * one token file that point omp at it.
 *
 * Why a seeded HOME rather than flags or environment variables: Apple
 * `container` cannot bind-mount a single file (`--volume host_file:/a/b/f`
 * fails with `NSPOSIXErrorDomain Code=20 "Not a directory"`), so a directory
 * mount is the only delivery channel that exists. The proven arrangement is
 * `--volume <hostDir>:/run/ompd-home` plus `--env HOME=/run/ompd-home`: the
 * guest reads `$HOME/.omp/agent/{models.yml,config.yml}` and writes its
 * `agent.db` as a sibling, and no secret appears in any argv.
 *
 * Nothing from `~/.omp` is copied or mounted. This directory is created fresh
 * per container, holds only the three generated files, and the caller removes
 * it when the container is destroyed.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSafePath } from "./gate-wrapper.ts";
import { ProvisionError } from "./types.ts";

/** Absolute path inside the guest where the seeded home is mounted. */
export const GUEST_HOME_MOUNT = "/run/ompd-home";

/**
 * What the broker granted this container: one endpoint, one bearer, one model.
 *
 * The token is a per-container bearer the broker minted and can revoke. It is
 * not a provider credential and is worthless anywhere but the broker's own
 * listener on the container network's gateway address.
 */
export interface GuestModelAccess {
  endpoint: string;
  token: string;
  model: string;
}

/**
 * Characters that would let an interpolated value escape the YAML scalar it is
 * written into. Refused rather than escaped, following `requireSafePath`: these
 * values come from daemon config, a container network address and a model id,
 * so one containing a quote is a sign something is wrong upstream, and quietly
 * escaping it would hide that. Refusing is also the cheaper answer -- there is
 * no legitimate model id or URL with a newline in it.
 */
const YAML_HOSTILE = /["'\\\n\r]/;

function requireYamlScalar(value: string, field: string): string {
  if (YAML_HOSTILE.test(value)) {
    throw new ProvisionError(
      `guest model access ${field} contains a quote, backslash or newline and cannot be written into the guest config`,
      "container",
    );
  }
  return value;
}

/**
 * Render `$HOME/.omp/agent/models.yml` for the guest.
 *
 * The shape here is the one measured to complete a real turn from inside a
 * container, not a plausible reconstruction of it. Three details in it are
 * load-bearing and each has been got wrong once:
 *
 * `baseUrl` carries NO trailing `/v1`. The Anthropic SDK appends `/v1/messages`
 * itself, so a `baseUrl` ending in `/v1` produces `/v1/v1/messages`, which the
 * broker's route allowlist refuses with a 404 that reads like a broken broker.
 *
 * `apiKey` is a `!cat` command rather than the token itself or the name of an
 * environment variable. omp resolves a `!`-prefixed value by running it and
 * taking stdout (`omp://models.md`, "Command-resolved secrets"). A literal
 * would put the bearer in `models.yml`, which is a file anything in the guest
 * can read and which is also the artifact most likely to be dumped into a log
 * while debugging; an environment variable would put it in the `container run`
 * argv, where any local process on the host can read it out of the process
 * table. `!cat` keeps the bearer in exactly one 0600 file and nowhere else.
 *
 * `disableStrictTools` is on because the request does not go straight to
 * Anthropic: it goes through the broker and then omp's own `auth-gateway`, and
 * a proxy in that position rejects the `strict` field on tool definitions. With
 * strict tools left enabled the turn fails on the first tool call rather than
 * at connect, which reads as a model problem rather than a transport one.
 */
export function renderGuestModelsYml(input: { endpoint: string; model: string; tokenPath: string }): string {
  const endpoint = requireYamlScalar(input.endpoint, "endpoint");
  const model = requireYamlScalar(input.model, "model");
  const tokenPath = requireYamlScalar(input.tokenPath, "tokenPath");

  // JSON.stringify is an exact YAML double-quoted scalar for any string that
  // has already been refused a quote, a backslash and a newline, so it is a
  // safe and dependency-free way to emit these three values.
  return `# Generated by ompd for one container. Do not edit.
#
# The provider below is the daemon's model broker, reachable only from this
# container's own network. It holds no provider credential of its own: it
# forwards to omp's auth-gateway on the host's loopback, which resolves the
# credential from the operator's existing vault. This guest never sees it.
providers:
  ompd-gateway:
    # No trailing /v1: the Anthropic SDK appends /v1/messages itself.
    baseUrl: ${JSON.stringify(endpoint)}
    api: anthropic-messages
    # '!<command>' means "run this and take stdout". The bearer therefore lives
    # in one 0600 file, not in this file and not in the container's argv.
    apiKey: ${JSON.stringify(`!cat ${tokenPath}`)}
    authHeader: true
    # The broker and auth-gateway sit in front of the Anthropic wire, and a
    # proxy there rejects the 'strict' field on tool definitions.
    disableStrictTools: true
    models:
      - id: ${JSON.stringify(model)}
        # The id is reused as the label: the guest has exactly one model and
        # inventing a prettier name for it would only make logs harder to match
        # against the grant.
        name: ${JSON.stringify(model)}
        input: [text]
        contextWindow: 200000
        maxTokens: 8192
        # Cost is zero because this entry is not a billing surface. The real
        # spend is attributed on the host, against the credential the gateway
        # resolved, and a made-up per-token price here would be a second,
        # wrong, number for the same request.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
`;
}

/**
 * Render `$HOME/.omp/agent/config.yml` for the guest.
 *
 * All three roles point at the one granted model. `default` is the obvious one;
 * `smol` and `tiny` are set as well because omp uses them for background work
 * it does without being asked -- session titles, thinking classification and
 * similar -- and a role left pointing at a provider the guest does not have
 * makes that work fail silently rather than loudly. The guest has exactly one
 * model available, so every role has exactly one honest value.
 */
export function renderGuestConfigYml(input: { model: string }): string {
  const model = requireYamlScalar(input.model, "model");
  const ref = JSON.stringify(`ompd-gateway/${model}`);

  return `# Generated by ompd for one container. Do not edit.
#
# Every role points at the single granted model. 'smol' and 'tiny' matter as
# much as 'default': omp uses them for background work such as session titles
# and thinking classification, and a role naming a provider that is not
# configured here fails quietly instead of loudly.
modelRoles:
  default: ${ref}
  smol: ${ref}
  tiny: ${ref}
`;
}

/**
 * Create the guest's home on the daemon's filesystem and return its path.
 *
 * `mkdtempSync` for the same reasons `writeGateWrapper` uses it: an
 * unpredictable directory created 0700 in one step cannot have been
 * pre-created world-writable by another local user, and `wx` on every write
 * means a planted file or symlink is never followed. This directory holds a
 * live bearer, so both properties are wanted here too.
 *
 * The caller removes this directory when the container is destroyed. On any
 * failure here it is removed before the error propagates, so a refused or
 * half-finished provision leaves nothing behind holding a token.
 */
export function seedGuestHome(input: { access: GuestModelAccess }): string {
  const { access } = input;
  const dir = mkdtempSync(join(tmpdir(), "ompd-guest-"));
  try {
    // The same check the container backend applies to the gate directory, for
    // the same reason: this path becomes a `--volume` source, and discovering a
    // hostile `TMPDIR` after the container had started with it would be too
    // late.
    requireSafePath(dir, "guest home directory", "container");

    // The path baked into models.yml is the path INSIDE the guest, not the
    // host path this function returns. They are different directories as far as
    // every process involved is concerned: the host sees the mkdtemp path, the
    // guest only ever sees the mount point. Writing the host path here is the
    // most likely mistake in this file, and it fails at the first prompt with
    // `cat: no such file`, which reads as a missing token rather than a wrong
    // path.
    const guestTokenPath = `${GUEST_HOME_MOUNT}/.omp/model-token`;

    // Rendered before anything is written so a hostile model id or endpoint is
    // refused while the only thing on disk is an empty directory, rather than
    // after the bearer has been written out.
    const modelsYml = renderGuestModelsYml({
      endpoint: access.endpoint,
      model: access.model,
      tokenPath: guestTokenPath,
    });
    const configYml = renderGuestConfigYml({ model: access.model });

    const ompDir = join(dir, ".omp");
    const agentDir = join(ompDir, "agent");
    for (const level of [ompDir, agentDir]) {
      // mkdir's mode is masked by the umask, and these directories hold a
      // credential, so the permission is asserted rather than requested.
      mkdirSync(level, { mode: 0o700 });
      chmodSync(level, 0o700);
    }

    // The token, and only the token, plus the newline `cat` will hand to omp.
    // Nothing else in this tree, and no log line, audit row or argv anywhere
    // in the daemon, ever carries this value.
    writeFileSync(join(ompDir, "model-token"), `${access.token}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(agentDir, "models.yml"), modelsYml, { mode: 0o600, flag: "wx" });
    writeFileSync(join(agentDir, "config.yml"), configYml, { mode: 0o600, flag: "wx" });

    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
