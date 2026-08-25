/**
 * IPv4 address-in-range arithmetic, for the model broker's peer check.
 *
 * The broker admits a request only from inside the container network's own
 * subnet, and Apple `container` assigns those subnets by creation order rather
 * than by network name: the first network gets `192.168.65.0/24`, the next one
 * `192.168.66.0/24`, and which is which depends on what else has been created
 * on the host. So the range is read from `network inspect` at provision time
 * and handed here as a string, never hardcoded.
 *
 * That is what makes a real parse necessary rather than a string comparison.
 * Prefix-matching `"192.168.6"` against a `192.168.6.0/24` grant would admit
 * `192.168.66.4`, a peer on somebody else's container network, which is exactly
 * the boundary this check exists to hold.
 *
 * IPv4 only, deliberately. Every peer address measured on this host arrives as
 * a dotted quad or as its IPv6-mapped form, and inventing IPv6 range arithmetic
 * for a case that does not occur would put untested code in front of a live
 * trust boundary. Anything this module cannot parse is not inside any range, so
 * the answer is `false` and the caller refuses: an address we do not understand
 * fails closed rather than being waved through.
 */

/**
 * How a peer arriving over a dual-stack socket spells an IPv4 address. It is
 * the same host as the bare quad and has to compare as such.
 */
const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * One octet, strictly. `Number("0x0a")`, `Number(" 10")` and `Number("+10")`
 * all parse to something, and `"010"` is octal 8 to `inet_aton` and ten to
 * `Number`. None of those spellings appears in an address any of this code
 * produces, and a lenient parse would turn each of them into a silently
 * different range, so the grammar is pinned to exactly what an address is.
 */
const OCTET = /^(0|[1-9]\d{0,2})$/;

/** A prefix length as written, before the 0..32 range check. */
const PREFIX = /^(0|[1-9]\d?)$/;

/** An IPv4 range as the two numbers a membership test actually needs. */
interface Ipv4Range {
  /** Network address, already masked. */
  base: number;
  /** Prefix mask as an unsigned 32-bit value. */
  mask: number;
}

/**
 * The dotted quad in `address`, or null when there is not one.
 *
 * Exported because the broker logs the normalised form in a refusal: an
 * operator reading `refused ... from 192.168.66.4` should not have to work out
 * that the socket reported `::ffff:192.168.66.4`.
 */
export function normalizeIpv4(address: string): string | null {
  const trimmed = address.trim();
  // Case-insensitive because the mapped prefix is hex; the prefix is pure
  // ASCII, so lowercasing cannot move the offset the slice uses.
  const bare = trimmed.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? trimmed.slice(IPV4_MAPPED_PREFIX.length)
    : trimmed;
  return ipv4ToUint32(bare) === null ? null : bare;
}

/** A dotted quad as an unsigned 32-bit value, or null when it is not one. */
function ipv4ToUint32(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** `a.b.c.d/n` as a range, or null when it is not a well-formed CIDR. */
function parseIpv4Cidr(cidr: string): Ipv4Range | null {
  const slash = cidr.indexOf("/");
  if (slash < 0) return null;
  const base = ipv4ToUint32(cidr.slice(0, slash));
  const prefixText = cidr.slice(slash + 1);
  if (base === null || !PREFIX.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > 32) return null;
  // `/0` is spelled out rather than computed: JS takes a shift count mod 32, so
  // `0xffffffff << 32` is `0xffffffff` and a `/0` would silently mask nothing
  // away and match only its own base address.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // Masked, so a range written with host bits set (`192.168.65.1/24`, which is
  // how a gateway address reads) still names the whole subnet.
  return { base: (base & mask) >>> 0, mask };
}

/**
 * Whether `address` is inside `cidr`. False for anything unparseable on either
 * side, so a malformed range admits nobody instead of everybody.
 */
export function addressInIpv4Cidr(address: string, cidr: string): boolean {
  const normalized = normalizeIpv4(address);
  if (normalized === null) return false;
  const value = ipv4ToUint32(normalized);
  const range = parseIpv4Cidr(cidr);
  if (value === null || range === null) return false;
  return (value & range.mask) >>> 0 === range.base;
}

/**
 * Whether `cidr` is a range this module can test against.
 *
 * The broker checks this when it mints a grant rather than when it serves a
 * request, because the two failures look nothing alike. A range that does not
 * parse makes `addressInIpv4Cidr` answer false for every peer, so the container
 * comes up, connects, and is refused on every prompt it ever sends. Caught at
 * mint time it is one thrown error naming the malformed range instead.
 */
export function isIpv4Cidr(cidr: string): boolean {
  return parseIpv4Cidr(cidr) !== null;
}
