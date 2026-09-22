import type { NetworkInterfaceInfo } from 'node:os';

/** The shape `os.networkInterfaces()` returns — injected so a spec needs no real machine. */
export type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const LINK_LOCAL_IPV4 = /^169\.254\./;

/** Non-internal, non-link-local IPv4 addresses across every interface. */
export function lanAddresses(interfaces: NetworkInterfaces): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family !== 'IPv4') {
        continue;
      }
      if (entry.internal) {
        continue;
      }
      if (LINK_LOCAL_IPV4.test(entry.address)) {
        continue;
      }
      addresses.push(entry.address);
    }
  }
  return addresses;
}

/**
 * `os.hostname()` normalised to `<name>.local`. macOS already publishes this
 * name over Bonjour with no help from this app — nothing here registers or
 * advertises anything, it only spells the address out.
 */
export function hostLocalName(hostname: string): string | null {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed === 'localhost') {
    return null;
  }
  const base = trimmed.endsWith('.local')
    ? trimmed.slice(0, -'.local'.length)
    : trimmed;
  if (base.length === 0) {
    return null;
  }
  return `${base}.local`;
}

export interface RemoteLinks {
  /** `http://<name>.local:<port>` — the primary link. */
  hostUrl: string | null;
  /** `http://<lan-ipv4>:<port>` — the fallback, for a network where `.local` does not resolve. */
  addressUrl: string | null;
}

export interface BuildRemoteLinksInput {
  hostname: string;
  interfaces: NetworkInterfaces;
}

/** The two URLs Settings shows. Both `null` when nothing can be built. */
export function buildRemoteLinks(
  port: number,
  { hostname, interfaces }: BuildRemoteLinksInput,
): RemoteLinks {
  const name = hostLocalName(hostname);
  const hostUrl = name ? `http://${name}:${port}` : null;

  // The FIRST reachable address, not every one — Settings shows one fallback
  // link, not a list, and the earliest-enumerated interface is ordinarily
  // the one macOS itself prefers for outbound traffic.
  const [address] = lanAddresses(interfaces);
  const addressUrl = address ? `http://${address}:${port}` : null;

  return { hostUrl, addressUrl };
}
