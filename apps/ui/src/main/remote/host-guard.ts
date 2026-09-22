/**
 * DNS-rebinding protection for the LAN gateway. Without this a page on the
 * open internet can point its own domain name at the user's LAN IP and drive
 * the gateway from the victim's own browser, since the browser attaches the
 * session cookie by HOST and never by address — the whole point of the guard
 * is to answer "is this Host header one WE would ever hand out", never
 * "does this address happen to be reachable".
 */

export interface HostGuardOptions {
  port: number;
  /** The machine's own hostname(s) — accepted by name as well as by address. */
  allowedHostNames: readonly string[];
}

interface ParsedHost {
  /** Lowercased; for a bracketed IPv6 literal, the address WITHOUT brackets. */
  hostname: string;
  isIpv6Literal: boolean;
  port: number | null;
}

const PORT_DIGITS = /^\d+$/;
const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];
const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const LINK_LOCAL_IPV6 = /^fe[89ab][0-9a-f]:/;
const UNIQUE_LOCAL_IPV6 = /^f[cd][0-9a-f]{2}:/;

/**
 * Splits an optional `:port` off a Host header value. A bracketed literal
 * (`[::1]:3000`) is handled first, since the colons INSIDE the brackets are
 * address separators, not the port separator — the naive `lastIndexOf(':')`
 * below would otherwise slice into the middle of the address.
 */
function parseHostHeader(hostHeader: string): ParsedHost | null {
  const value = hostHeader.trim();
  if (value.length === 0) {
    return null;
  }

  if (value.startsWith('[')) {
    const closeIndex = value.indexOf(']');
    if (closeIndex === -1) {
      return null;
    }
    const hostname = value.slice(1, closeIndex).toLowerCase();
    const rest = value.slice(closeIndex + 1);
    if (rest.length === 0) {
      return { hostname, isIpv6Literal: true, port: null };
    }
    if (!rest.startsWith(':')) {
      return null;
    }
    const portText = rest.slice(1);
    if (!PORT_DIGITS.test(portText)) {
      return null;
    }
    return { hostname, isIpv6Literal: true, port: Number(portText) };
  }

  const colonIndex = value.lastIndexOf(':');
  if (colonIndex === -1) {
    return { hostname: value.toLowerCase(), isIpv6Literal: false, port: null };
  }
  const beforeColon = value.slice(0, colonIndex);
  const portText = value.slice(colonIndex + 1);
  // A real Host:port pair never has a second colon before the split — an
  // unbracketed value with one is an (invalid, unbracketed) IPv6 literal,
  // and slicing it on the last colon would tear a hextet off as a "port".
  if (PORT_DIGITS.test(portText) && !beforeColon.includes(':')) {
    return {
      hostname: beforeColon.toLowerCase(),
      isIpv6Literal: false,
      port: Number(portText),
    };
  }
  return { hostname: value.toLowerCase(), isIpv6Literal: false, port: null };
}

function isPrivateIpv4Literal(hostname: string): boolean {
  if (!IPV4_LITERAL.test(hostname)) {
    return false;
  }
  return PRIVATE_IPV4_RANGES.some((range) => range.test(hostname));
}

/**
 * Whether an IPv6 literal names an address only a machine on this link could
 * be using.
 *
 * Rebinding is not the only thing this guard answers. It is also what bounds
 * WHICH networks may reach the gateway by Host at all, and that distinction
 * is not academic on a Mac: SLAAC routinely hands one a globally-routable
 * IPv6 address, so accepting every literal would publish a LAN feature to the
 * open internet the moment the listener answered on `::`. Only loopback, the
 * link-local range and the unique-local range can name something on this
 * network; global unicast is refused.
 *
 * An IPv4-mapped literal (`::ffff:192.168.1.7`) is decided by the address it
 * carries, because that is the address the packet is really about — reading
 * it as an opaque v6 string would refuse a legitimate LAN host on a
 * dual-stack machine.
 */
function isPrivateIpv6Literal(hostname: string): boolean {
  if (hostname === '::1') {
    return true;
  }
  const mapped = IPV4_MAPPED.exec(hostname);
  if (mapped?.[1]) {
    return isPrivateIpv4Literal(mapped[1]);
  }
  // fe80::/10 is link-local and fc00::/7 unique-local. Matched on the leading
  // hextet rather than by expanding the address, because both ranges are
  // decided entirely by their first two bytes and expansion would be a second
  // parser to get wrong.
  return LINK_LOCAL_IPV6.test(hostname) || UNIQUE_LOCAL_IPV6.test(hostname);
}

/**
 * Whether a `*.suffix` entry in {@link HostGuardOptions.allowedHostNames}
 * admits this hostname.
 *
 * A wildcard is what a TUNNEL needs. Every tunnel client mints a fresh
 * subdomain on each start, and ngrok was measured reassigning one MID-SESSION
 * (`9b36-…` → `5cd3-…` on a reconnect), so pinning the current value would not
 * hold even for the life of one tunnel: the suffix is the only stable part of
 * the address.
 *
 * Two shapes are refused rather than matched, and both refusals are the point
 * of the module. A bare `*` is every host there is — the guard switched off.
 * And a ONE-LABEL suffix (`*.app`) is a whole TLD, inside which a stranger can
 * register a name, point a low-TTL record at this machine's LAN address and
 * rebind straight through. Requiring two labels leaves the zone in the hands
 * of whichever provider the user chose to route through, which is the whole
 * basis on which a wildcard is safe at all: an attacker cannot make
 * `evil.trycloudflare.com` resolve to a victim's LAN IP, because Cloudflare
 * owns that zone and not them.
 */
function wildcardAdmits(entry: string, hostname: string): boolean {
  if (!entry.startsWith('*.')) {
    return false;
  }
  const suffix = entry.slice(2).toLowerCase();
  if (!suffix.includes('.')) {
    return false;
  }
  // The leading dot is what makes this a LABEL boundary rather than a string
  // one: without it `evilngrok-free.app` ends with `ngrok-free.app` and would
  // be admitted by a name its owner does not control.
  return hostname.endsWith(`.${suffix}`);
}

export function isAllowedHost(
  hostHeader: string | null | undefined,
  options: HostGuardOptions,
): boolean {
  if (!hostHeader) {
    return false;
  }
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) {
    return false;
  }

  const { hostname, isIpv6Literal } = parsed;

  // Checked BEFORE the port, and a wildcard is the only entry that is. It
  // admits a name this listener does not serve directly — a tunnel's, whose
  // port is the tunnel's 443 rather than the one bound here — while every arm
  // below is about an address that reaches this socket, where the port is
  // part of the claim being made.
  if (
    !isIpv6Literal &&
    options.allowedHostNames.some((name) => wildcardAdmits(name, hostname))
  ) {
    return true;
  }

  if (parsed.port !== null && parsed.port !== options.port) {
    return false;
  }

  if (isIpv6Literal) {
    return isPrivateIpv6Literal(hostname);
  }
  if (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'localhost'
  ) {
    return true;
  }
  if (isPrivateIpv4Literal(hostname)) {
    return true;
  }
  if (hostname.endsWith('.local')) {
    return true;
  }
  return options.allowedHostNames.some(
    (name) => name.toLowerCase() === hostname,
  );
}
