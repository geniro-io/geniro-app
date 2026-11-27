import { lookup, Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { REMOTE_ROUTE_SESSION } from '../../shared/remote';
import {
  TUNNEL_PUBLIC_ANSWER_MAX_BYTES,
  TUNNEL_PUBLIC_DNS_TIMEOUT_MS,
  TUNNEL_PUBLIC_NAMESERVERS_TIMEOUT_MS,
  TUNNEL_PUBLIC_PROBE_TIMEOUT_MS,
} from './remote.types';

/**
 * The zone a tunnel's host lives in: the host without its leading label, the
 * part every address the provider hands out shares. Null for a host too short
 * to have one that is not a whole TLD.
 */
export function tunnelZone(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  if (labels.length < 3) {
    return null;
  }
  return labels.slice(1).join('.');
}

/** Whether a body is the gateway's own session answer, which nothing in front of it could produce. */
export function isGatewaySessionAnswer(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'paired' in parsed &&
    typeof parsed.paired === 'boolean' &&
    'deviceId' in parsed
  );
}

export interface PublicProbeDeps {
  /** The addresses of the nameservers that hold `zone`. */
  zoneNameservers(zone: string): Promise<string[]>;
  /** The addresses `servers` give for `host`, asked of them alone. */
  resolveAt(servers: string[], host: string): Promise<string[]>;
  /** Whether `https://host` reached at `address` answers with this gateway's session route. */
  reachesGateway(host: string, address: string): Promise<boolean>;
}

async function zoneNameservers(zone: string): Promise<string[]> {
  const resolver = new Resolver({
    timeout: TUNNEL_PUBLIC_DNS_TIMEOUT_MS,
    tries: 1,
  });
  const names = await resolver.resolveNs(zone);
  const found = await Promise.all(
    names.map((name) =>
      lookup(name, { all: true }).then(
        (entries) => entries,
        () => [],
      ),
    ),
  );
  return found
    .flat()
    .sort((a, b) => a.family - b.family)
    .map((entry) => entry.address);
}

async function resolveAt(servers: string[], host: string): Promise<string[]> {
  const resolver = new Resolver({
    timeout: TUNNEL_PUBLIC_DNS_TIMEOUT_MS,
    tries: 1,
  });
  resolver.setServers(servers);
  const v4 = await resolver.resolve4(host).catch((): string[] => []);
  if (v4.length > 0) {
    return v4;
  }
  return resolver.resolve6(host).catch((): string[] => []);
}

function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface GatewayRequestOptions {
  /** Test seam: `node:http`'s `request` against a local stand, which needs no certificate. */
  request?: typeof httpsRequest;
  port?: number;
}

export function reachesGateway(
  host: string,
  address: string,
  options: GatewayRequestOptions = {},
): Promise<boolean> {
  const family = isIP(address);
  const pinned: LookupFunction = (_name, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
  const send = options.request ?? httpsRequest;
  return new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => {
      req.destroy();
      resolve(false);
    }, TUNNEL_PUBLIC_PROBE_TIMEOUT_MS);
    deadline.unref?.();
    const done = (answer: boolean): void => {
      clearTimeout(deadline);
      resolve(answer);
    };
    const req = send(
      {
        host,
        port: options.port,
        servername: host,
        path: REMOTE_ROUTE_SESSION,
        method: 'GET',
        headers: { accept: 'application/json' },
        lookup: pinned,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > TUNNEL_PUBLIC_ANSWER_MAX_BYTES) {
            req.destroy();
            done(false);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          done(
            res.statusCode === 200 &&
              isGatewaySessionAnswer(Buffer.concat(chunks).toString('utf8')),
          );
        });
        res.on('error', () => done(false));
        res.on('close', () => done(false));
      },
    );
    req.on('error', () => done(false));
    req.end();
  });
}

const SYSTEM: PublicProbeDeps = {
  zoneNameservers: (zone) =>
    withDeadline(
      zoneNameservers(zone),
      TUNNEL_PUBLIC_NAMESERVERS_TIMEOUT_MS,
      [],
    ),
  resolveAt,
  reachesGateway: (host, address) => reachesGateway(host, address),
};

/**
 * A check that a tunnel's public address is served end to end: its name is
 * in DNS and the provider's edge forwards it to this gateway.
 *
 * The new name is asked of the zone's own nameservers and never of the system
 * resolver: a lookup that beats the record is kept as NXDOMAIN by the user's
 * router, which is the dead address this check exists to prevent. The zone's
 * nameservers are read on the first call and again after a failed read.
 */
export function createPublicProbe(
  deps: PublicProbeDeps = SYSTEM,
): (url: string) => Promise<boolean> {
  let nameservers: Promise<string[]> | null = null;
  return async (url) => {
    const zone = tunnelZone(url);
    if (!zone) {
      return false;
    }
    const host = new URL(url).hostname.toLowerCase();
    nameservers ??= deps.zoneNameservers(zone).catch((): string[] => []);
    const servers = await nameservers;
    if (servers.length === 0) {
      nameservers = null;
      return false;
    }
    const addresses = await deps
      .resolveAt(servers, host)
      .catch((): string[] => []);
    const [address] = addresses;
    if (!address) {
      return false;
    }
    return deps.reachesGateway(host, address).catch(() => false);
  };
}
