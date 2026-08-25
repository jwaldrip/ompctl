/**
 * The reviewed record of every third-party byte the default container toolchain
 * puts inside a host.
 *
 * This file is data, deliberately. There is no fetching, no fallback and no
 * derivation here, because the whole point is that a human reviewed each value
 * and wrote it down. `image.ts` may only mount what appears below.
 *
 * What this replaced, and why
 * ---------------------------
 * The previous version named `debian:bookworm-slim` and `alpine:3.20` as bare
 * tags and downloaded whatever `omp-linux-<arch>` the release URL served, then
 * hashed the result and used its own hash as the cache key. That last part is
 * the defect worth naming: a digest computed after a download describes what
 * arrived, not what was supposed to arrive. It makes the cache honest about
 * itself and says nothing at all about provenance. A substituted asset would
 * have been hashed, cached under its own digest, and mounted, and every check
 * downstream would have agreed with it. Tags are the same problem with a
 * schedule: `debian:bookworm-slim` moves on Debian's point releases and
 * `alpine:3.20` on Alpine's, so the base a host ran last week is not
 * necessarily the base it runs today, and nothing in the daemon would notice.
 *
 * So every value here is an expectation recorded ahead of time, and `image.ts`
 * compares against it and refuses on a mismatch.
 *
 * Which digest is pinned for an image, and why that choice
 * -------------------------------------------------------
 * A multi-arch repository tag resolves to an OCI image *index* (what Docker
 * calls a manifest list), and the index in turn names one *manifest* per
 * platform. Those are two different digests and pinning the wrong one is the
 * easy mistake here:
 *
 *   - The index digest is arch-independent. It names the whole set, so one
 *     pinned string works on an arm64 Mac and an x86_64 Linux box alike.
 *   - A per-platform manifest digest names exactly one architecture. Pinning
 *     one would work on the machine it was captured on and fail everywhere
 *     else, which is a portability bug that only shows up on someone else's
 *     hardware.
 *
 * Both are pinned below for the record, and `PinnedImage.digest` is the index
 * digest. Measured rather than assumed, on this machine (2026-08-24):
 *
 *   $ curl -sS -D- -o/dev/null -H "Authorization: Bearer $TOK" \
 *       -H 'Accept: application/vnd.oci.image.index.v1+json' \
 *       https://registry-1.docker.io/v2/library/debian/manifests/bookworm-slim
 *     content-type: application/vnd.oci.image.index.v1+json
 *     docker-content-digest: sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
 *
 *   $ container images inspect debian:bookworm-slim
 *     "index":{"mediaType":"application/vnd.oci.image.index.v1+json",
 *              "digest":"sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171","size":5651}
 *
 * The runtime's own record and the registry agree, so the index digest is the
 * thing both sides of this can talk about.
 *
 * Apple `container` 0.4.1 enforces the pin, which was worth checking
 * -----------------------------------------------------------------
 * A digest-pinned reference is only worth writing if the runtime honours it. It
 * does, and it was proven by contradiction rather than by a passing run, all on
 * `container` 0.4.1 on 2026-08-24:
 *
 *   $ container run --rm debian:bullseye-slim@sha256:88200866...4171 cat /etc/debian_version
 *     12.15                      <- bookworm, the digest, NOT the bullseye tag
 *   $ container run --rm debian:bullseye-slim cat /etc/debian_version
 *     11.11                      <- bullseye, the tag
 *
 * A deliberately mismatched tag loses to the digest, so the digest is what is
 * actually resolved. And a digest that does not exist is refused rather than
 * quietly falling back to the tag:
 *
 *   $ container run --rm debian:bookworm-slim@sha256:0000...0000 true
 *     Error: unknown: "HTTP request to
 *     https://registry-1.docker.io/v2/library/debian/manifests/sha256:0000...0000
 *     failed with response: 404 Not Found. Reason: Unknown"    (exit 1)
 *
 * `container run --rm debian@sha256:88200866...4171` (no tag at all) is also
 * accepted, and `docker run` accepts the same `<tag>@<digest>` spelling. So the
 * pin is carried in argv and enforced by the runtime, and there is no need for
 * a second `container images inspect` pass to confirm the digest after a pull.
 * That was the fallback plan had the CLI rejected pinned references; it is not
 * in force, and `image.ts` says so where it builds the reference.
 *
 * Alpine's trust store is arch-independent, which is why one constant is enough
 * ---------------------------------------------------------------------------
 * `CA_BUNDLE_SHA256` is a single value rather than one per architecture, and
 * that is a measurement, not an assumption. Both platform layers were pulled
 * straight from the registry, bypassing every runtime, and unpacked
 * (2026-08-24):
 *
 *   arm64 layer sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78
 *   amd64 layer sha256:25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471
 *   $ tar -xzOf alpine-<arch>.tar.gz etc/ssl/certs/ca-certificates.crt | shasum -a 256
 *     both: 217769 bytes, 145 certificates,
 *           61efbd6d3f829f71039c57b29dd37d15ac7f33c4ece861aaef8c7d7a519cd1d9
 *
 * Apple `container` reproduces that byte for byte. OrbStack's docker does not,
 * and finding out why is the reason this constant earns its keep: docker
 * returned 218540 bytes and 146 certificates from the same pinned index, and
 * the extra subject is `O=OrbStack Development, OU=Containers & Services,
 * CN=OrbStack Development Root CA`. The runtime is injecting its own root CA
 * into the trust store on the way out. It is not malicious, but it is an
 * unreviewed certificate authority landing in the file `SSL_CERT_FILE` points
 * at for a host's model traffic, arriving from the runtime rather than from the
 * image anyone reviewed. Comparing against this constant is what turns that
 * from invisible into a refusal, so on an OrbStack docker host the default
 * toolchain path now fails closed and says which digest it got. That is the
 * intended behaviour and not a bug to route around.
 *
 * omp release digests come from upstream, not from our own download
 * ----------------------------------------------------------------
 * Each release publishes a `SHA256SUMS.txt` asset, so the expectation below is
 * upstream's own statement about its artefacts and not our arithmetic on
 * whatever the CDN served us (2026-08-24):
 *
 *   $ curl -sSL https://github.com/can1357/oh-my-pi/releases/download/v18.0.4/SHA256SUMS.txt
 *     f2b7c8a019681ede314ac165100c1c5b5cd4900139075948da809c004bec5ce7  omp-linux-arm64
 *     94ec42d17d71975a381e20335bb3c005a7fd7eec19b319358df6d22f28e16b37  omp-linux-x64
 *
 *   $ shasum -a 256 -c SHA256SUMS.txt
 *     omp-linux-arm64: OK
 *     omp-linux-x64: OK
 *
 * Byte counts are from the release API, and are pinned alongside the digests so
 * a truncated transfer is caught by a cheap comparison before 145MB is hashed:
 *
 *   $ curl -sS https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v18.0.4 \
 *       | jq -r '.assets[] | "\(.name)  \(.size)"'
 *     omp-linux-arm64  145082360
 *     omp-linux-x64    179881160
 *
 * Adding a release
 * ----------------
 * An `omp --version` with no entry here is refused, by design, with the
 * instruction to come and add one. Doing that means reviewing the release, not
 * pasting whatever the URL currently returns:
 *
 *   1. Read `SHA256SUMS.txt` for the tag and take the digests from it.
 *   2. Download each asset and confirm `shasum -a 256 -c SHA256SUMS.txt` passes,
 *      so the published sums and the served bytes agree.
 *   3. Record the byte count from the release API.
 *   4. Add one `OMP_RELEASES` entry per architecture, with the commands and the
 *      date, in the style above.
 *
 * The musl builds (`omp-linux-musl-arm64`, `omp-linux-musl-x64`) are published
 * and deliberately absent: the pinned base is glibc-based debian, so the glibc
 * builds are the ones that run on it. They would belong here alongside an
 * alpine base, which is not what this module mounts.
 */

/** One reviewed `omp-linux-<arch>` release asset. */
export interface OmpRelease {
  /** As printed by `omp --version`, with the `omp/` prefix stripped. */
  version: string;
  /** As spelled in the release asset name: `arm64` or `x64`. */
  arch: string;
  /** From upstream's `SHA256SUMS.txt`, not from our own download. */
  sha256: string;
  /** From the release API. Checked before hashing, so a short transfer is cheap to catch. */
  bytes: number;
  url: string;
}

/**
 * A public base image pinned to a reviewed digest.
 *
 * `ref` carries the tag as well as the digest. The tag is decoration as far as
 * resolution goes (proven above: the digest wins over a contradicting tag), and
 * it is kept because it is what makes a `ps` listing or a log line legible to
 * whoever is reading it at the time.
 */
export interface PinnedImage {
  /** Runnable, digest-pinned: `<repo>:<tag>@sha256:<digest>`. */
  ref: string;
  /** The OCI image index digest. Arch-independent; see the module comment. */
  digest: string;
  description: string;
}

const RELEASE_BASE = "https://github.com/can1357/oh-my-pi/releases/download";

/**
 * Every omp release the default toolchain is allowed to mount.
 *
 * 18.0.4 only, because that is the release that was reviewed and the one whose
 * bytes were run against the pinned base. An `omp --version` reporting anything
 * else is a refusal with instructions rather than a download, which is the
 * whole point: a version nobody has looked at cannot arrive by accident.
 *
 * Both entries verified on 2026-08-24 by the commands in the module comment:
 * upstream `SHA256SUMS.txt` for the digests, the release API for the sizes, and
 * `shasum -a 256 -c SHA256SUMS.txt` reporting `OK` for both assets after
 * download. The arm64 build was additionally executed on the pinned base:
 *
 *   $ container run --rm --volume /tmp/pin-evidence/tools:/opt/ompd:ro \
 *       debian:bookworm-slim@sha256:88200866...4171 /opt/ompd/omp --version
 *     omp/18.0.4
 *
 * The x64 digest is reviewed but not executed here: this is an arm64 machine,
 * and running it would mean emulation, which proves something about the
 * emulator rather than about the binary. [INFERENCE] It is expected to behave
 * as the arm64 build does on an x86_64 host.
 */
export const OMP_RELEASES: readonly OmpRelease[] = [
  {
    version: "18.0.4",
    arch: "arm64",
    sha256: "f2b7c8a019681ede314ac165100c1c5b5cd4900139075948da809c004bec5ce7",
    bytes: 145082360,
    url: `${RELEASE_BASE}/v18.0.4/omp-linux-arm64`,
  },
  {
    version: "18.0.4",
    arch: "x64",
    sha256: "94ec42d17d71975a381e20335bb3c005a7fd7eec19b319358df6d22f28e16b37",
    bytes: 179881160,
    url: `${RELEASE_BASE}/v18.0.4/omp-linux-x64`,
  },
  // 17.3.4 is here because it is what this repo actually resolves under
  // `bun run`: the workspace catalog pins `@oh-my-pi/pi-coding-agent@17.3.4`,
  // whose bin shadows a newer omp on PATH, so a daemon started from the
  // checkout asks for 17.3.4 while the same shell's `omp --version` says
  // 18.0.4. Found by the thin-path check refusing to fetch an unpinned
  // release, which is the guard working rather than failing. Both digests are
  // upstream's own, from
  // `curl -sSL .../v17.3.4/SHA256SUMS.txt` on 2026-08-25, byte counts from
  // `curl -sS api.github.com/repos/can1357/oh-my-pi/releases/tags/v17.3.4`.
  {
    version: "17.3.4",
    arch: "arm64",
    sha256: "8e27e7bfe49fc0f33f6cb0b50128ab85fe5403330d1dfb5bb34cf1f7422cdce8",
    bytes: 145664144,
    url: `${RELEASE_BASE}/v17.3.4/omp-linux-arm64`,
  },
  {
    version: "17.3.4",
    arch: "x64",
    sha256: "3fce4b25628064b0cd7bfbc6245ecdada331750ed4b341aca6bd29ba4478aab5",
    bytes: 177752192,
    url: `${RELEASE_BASE}/v17.3.4/omp-linux-x64`,
  },
];

/**
 * The base image every default container host runs.
 *
 * debian-slim by measurement. The omp release is a glibc build, so on
 * `alpine:3.20` it cannot be executed at all (`sh: /opt/ompd/omp: not found`),
 * and debian-slim already carries every coreutil the shim and the gate
 * wrapper's far side need: sh, mkdir, chmod, tee, cat, cp, mktemp. It is
 * qualified to Docker Hub's public library on purpose, because being pullable
 * with no credential is the failure this whole toolchain exists to remove.
 *
 * Tag `bookworm-slim` resolved to this index digest on 2026-08-24. The
 * per-platform manifests inside it, recorded so the next person does not have
 * to re-derive which digest is which:
 *
 *   linux/arm64/v8  sha256:6bd27d44e6c32a66bbd72d7cb2b76a8ae3497ec2e5274a81abd1b37f6013fa1f
 *   linux/amd64     sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867
 *
 * Contents at this digest: `cat /etc/debian_version` gives `12.15`.
 */
export const BASE_IMAGE: PinnedImage = {
  ref: "debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171",
  digest: "sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171",
  description: "debian:bookworm-slim, glibc base for the mounted omp release",
};

/**
 * Where the CA bundle is copied from.
 *
 * Neither `debian:bookworm-slim` nor `debian:bookworm` ships
 * `/etc/ssl/certs/ca-certificates.crt` (verified: `ls` inside debian-slim gives
 * `cannot access ...: No such file or directory`), and omp reaches a model over
 * TLS. Alpine ships one, so it is copied out of a public image once rather than
 * pointing `apt-get` at the network from inside a container that has no reason
 * to hold a package manager.
 *
 * Tag `3.20` resolved to this index digest on 2026-08-24. Per-platform
 * manifests inside it:
 *
 *   linux/arm64/v8  sha256:45e09956dc667c5eff3583c9d94830261fb1ca0be10a0a7db36266edf5de9e1d
 *   linux/amd64     sha256:c64c687cbea9300178b30c95835354e34c4e4febc4badfe27102879de0483b5e
 *
 * Contents at this digest: `cat /etc/alpine-release` gives `3.20.10`.
 */
export const CA_SOURCE_IMAGE_PIN: PinnedImage = {
  ref: "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
  digest: "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
  description: "alpine:3.20, source of the Mozilla CA bundle mounted into hosts",
};

/**
 * The trust store that is allowed to be mounted, by digest.
 *
 * 217769 bytes, 145 certificates. Taken from the registry layers of the pinned
 * index rather than from any runtime's output, for both arm64 and amd64, which
 * came out identical; see the module comment for the commands. One constant is
 * therefore correct for every architecture.
 *
 * This is the value that catches a runtime editing the bundle on the way out,
 * which is not hypothetical: OrbStack's docker adds its own development root CA
 * and produces 218540 bytes and 146 certificates from this exact index.
 *
 * Both halves of that are committed as fixtures rather than left to a live
 * docker call in a test, because a test that has to find OrbStack running is a
 * test that quietly stops checking anything:
 * `test/fixtures/ca-bundle/alpine-3.20-ca-certificates.crt` is the reviewed
 * bundle, and `orbstack-development-root-ca.pem` is the 771 bytes docker adds.
 * The reviewed bundle is a byte-exact prefix of docker's output, so
 * concatenating the two reproduces what OrbStack actually returned, digest
 * included:
 *
 *   $ head -c 217769 docker-ca.crt | shasum -a 256
 *     61efbd6d3f829f71039c57b29dd37d15ac7f33c4ece861aaef8c7d7a519cd1d9   <- the reviewed bundle
 *   $ cat registry-arm64-ca.crt orbstack-root-ca.pem | shasum -a 256
 *     7fb4cfe27cc2dd56156b5a5d0fa78f678056b855d9683d6a7424cf2215289fcc   <- docker's own output
 *
 * If the pin above ever moves, both fixtures have to be regenerated, which is
 * the review step this whole module exists to force.
 */
export const CA_BUNDLE_SHA256 = "61efbd6d3f829f71039c57b29dd37d15ac7f33c4ece861aaef8c7d7a519cd1d9";

/** Expected byte length of the reviewed bundle. Checked before hashing 217KB. */
export const CA_BUNDLE_BYTES = 217769;

/**
 * How many certificates the reviewed bundle holds.
 *
 * Carried purely so a refusal can say "146 certificates where 145 were
 * reviewed", which is the sentence that turns a digest mismatch from a wall of
 * hex into an instant diagnosis. Counting PEM headers is one scan of a string
 * already in memory; parsing X.509 to name the intruder would not be, and the
 * one runtime observed doing this is named in the message instead.
 */
export const CA_BUNDLE_CERT_COUNT = 145;

/** The PEM header, so both the floor check and the certificate count agree on what one looks like. */
export const CA_PEM_HEADER = "-----BEGIN CERTIFICATE-----";

/**
 * The one non-reviewed bundle shape that has a name, recorded so a refusal can
 * use it.
 *
 * This is emphatically NOT a second accept-list, and the distinction is the
 * whole reason it needs a comment. `CA_BUNDLE_SHA256` above is the only digest
 * `image.ts` will ever mount. This constant is compared against only on the way
 * into an error message, to upgrade "sha256 7fb4cf... is not the reviewed
 * 61efbd..." into "that is OrbStack's docker adding its own root CA", which is
 * the difference between an operator reading two lines of hex and an operator
 * knowing what to do next. Nothing branches on it and a match still refuses.
 *
 * Measured rather than derived: it is the reviewed bundle with OrbStack's own
 * root appended, and both halves are committed as fixtures so no test has to
 * find a running docker (2026-08-24):
 *
 *   $ cat test/fixtures/ca-bundle/alpine-3.20-ca-certificates.crt \
 *         test/fixtures/ca-bundle/orbstack-development-root-ca.pem | shasum -a 256
 *     7fb4cfe27cc2dd56156b5a5d0fa78f678056b855d9683d6a7424cf2215289fcc
 *     218540 bytes, 146 certificates
 */
export const CA_BUNDLE_ORBSTACK_SHA256 = "7fb4cfe27cc2dd56156b5a5d0fa78f678056b855d9683d6a7424cf2215289fcc";

/** The subject OrbStack's docker appends, quoted from the certificate it injects. */
export const CA_ORBSTACK_SUBJECT = "O=OrbStack Development, OU=Containers & Services, CN=OrbStack Development Root CA";

/**
 * The reviewed release for a version and architecture, or undefined.
 *
 * Undefined is a refusal at the call site, never a licence to go and fetch
 * something unpinned. That is the only reason this returns a value rather than
 * throwing: the caller owns the error message, and it needs to name the
 * version, the architecture and how to add an entry.
 *
 * `releases` defaults to the real manifest and is only ever passed by tests, so
 * they can exercise a successful provision without producing 145MB of bytes
 * that hash to a reviewed digest. See `EnsureToolchainOptions.releases` for why
 * that is not a way around the pin.
 */
export function ompRelease(
  version: string,
  arch: string,
  releases: readonly OmpRelease[] = OMP_RELEASES,
): OmpRelease | undefined {
  return releases.find(entry => entry.version === version && entry.arch === arch);
}

/** Every version and architecture some reviewed release covers, so a refusal can say what is available. */
export function reviewedVersions(releases: readonly OmpRelease[] = OMP_RELEASES): string[] {
  return [...new Set(releases.map(entry => `${entry.version} (${entry.arch})`))].sort();
}
