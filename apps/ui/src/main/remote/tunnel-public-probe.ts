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

/**
 * What one check found: the address `answers` through the gateway; it does
 * `not-yet` (its name is not in DNS, or the edge answered with something that
 * is not the gateway); or this Mac `cannot-check` it (the nameservers cannot be
 * reached or are not the zone's own, or the request failed below HTTP).
 */
export type PublicProbeOutcome = 'answers' | 'not-yet' | 'cannot-check';

/** What the zone's nameservers said about a name: its addresses, that it does not exist, or nothing. */
export type NameAnswer = { addresses: string[] } | 'missing' | 'unreachable';

export interface PublicProbeDeps {
  /** The addresses of the nameservers that hold `zone`. */
  zoneNameservers(zone: string): Promise<string[]>;
  /**
   * Whether `servers` behave as the zone's own nameservers, which refuse a
   * name outside it; false when a resolver on the way answers instead; null
   * when they could not be reached.
   */
  answersAsAuthority(servers: string[]): Promise<boolean | null>;
  /** What `servers` say about `host`, asked of them alone. */
  resolveAt(servers: string[], host: string): Promise<NameAnswer>;
  /** What `https://host` reached at `address` answers on this gateway's session route. */
  reachesGateway(host: string, address: string): Promise<PublicProbeOutcome>;
}

/** A name that exists nowhere, so only a recursive resolver answers for it rather than refusing. */
const OUTSIDE_ANY_ZONE = 'geniro-check.invalid';

const NO_SUCH_NAME = new Set(['ENOTFOUND', 'ENODATA']);

function errorCode(err: unknown): string | null {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : null;
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

function resolverAt(servers: string[]): Resolver {
  const resolver = new Resolver({
    timeout: TUNNEL_PUBLIC_DNS_TIMEOUT_MS,
    tries: 1,
  });
  resolver.setServers(servers);
  return resolver;
}

async function answersAsAuthority(servers: string[]): Promise<boolean | null> {
  try {
    await resolverAt(servers).resolve4(OUTSIDE_ANY_ZONE);
    return false;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'EREFUSED') {
      return true;
    }
    return code !== null && NO_SUCH_NAME.has(code) ? false : null;
  }
}

async function resolveAt(servers: string[], host: string): Promise<NameAnswer> {
  const resolver = resolverAt(servers);
  let missing = false;
  for (const ask of [
    () => resolver.resolve4(host),
    () => resolver.resolve6(host),
  ]) {
    try {
      const addresses = await ask();
      if (addresses.length > 0) {
        return { addresses };
      }
      missing = true;
    } catch (err) {
      const code = errorCode(err);
      if (code === null || !NO_SUCH_NAME.has(code)) {
        return 'unreachable';
      }
      missing = true;
    }
  }
  return missing ? 'missing' : 'unreachable';
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
): Promise<PublicProbeOutcome> {
  const family = isIP(address);
  const pinned: LookupFunction = (_name, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
  const send = options.request ?? httpsRequest;
  return new Promise<PublicProbeOutcome>((resolve) => {
    let answered = false;
    const deadline = setTimeout(() => {
      req.destroy();
      resolve(answered ? 'not-yet' : 'cannot-check');
    }, TUNNEL_PUBLIC_PROBE_TIMEOUT_MS);
    deadline.unref?.();
    const done = (outcome: PublicProbeOutcome): void => {
      clearTimeout(deadline);
      resolve(outcome);
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
        answered = true;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > TUNNEL_PUBLIC_ANSWER_MAX_BYTES) {
            req.destroy();
            done('not-yet');
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          done(
            res.statusCode === 200 &&
              isGatewaySessionAnswer(Buffer.concat(chunks).toString('utf8'))
              ? 'answers'
              : 'not-yet',
          );
        });
        res.on('error', () => done('not-yet'));
        res.on('close', () => done('not-yet'));
      },
    );
    req.on('error', () => done(answered ? 'not-yet' : 'cannot-check'));
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
  answersAsAuthority,
  resolveAt,
  reachesGateway: (host, address) => reachesGateway(host, address),
};

/** How many of the name's addresses one check tries before it gives up on this Mac reaching any. */
const ADDRESSES_TRIED = 2;

/**
 * A check that a tunnel's public address is served end to end: its name is
 * in DNS and the provider's edge forwards it to this gateway.
 *
 * The new name is asked of the zone's own nameservers and never of the system
 * resolver: a lookup that beats the record is kept as NXDOMAIN by the user's
 * router, which is the dead address this check exists to prevent. Before that,
 * the nameservers are asked once for a name outside every zone: a network that
 * hands port 53 to its own resolver answers it where the real ones refuse, and
 * on such a network the new name is never asked at all. The zone's nameservers
 * are read on the first call and again after a failed read.
 */
export function createPublicProbe(
  deps: PublicProbeDeps = SYSTEM,
): (url: string) => Promise<PublicProbeOutcome> {
  let nameservers: Promise<string[]> | null = null;
  let authority: boolean | null = null;
  return async (url) => {
    const zone = tunnelZone(url);
    if (!zone) {
      return 'cannot-check';
    }
    const host = new URL(url).hostname.toLowerCase();
    nameservers ??= deps.zoneNameservers(zone).catch((): string[] => []);
    const servers = await nameservers;
    if (servers.length === 0) {
      nameservers = null;
      return 'cannot-check';
    }
    if (authority === null) {
      authority = await deps
        .answersAsAuthority(servers)
        .catch((): boolean | null => null);
    }
    if (authority !== true) {
      return 'cannot-check';
    }
    const name = await deps
      .resolveAt(servers, host)
      .catch((): NameAnswer => 'unreachable');
    if (name === 'missing') {
      return 'not-yet';
    }
    if (name === 'unreachable') {
      return 'cannot-check';
    }
    for (const address of name.addresses.slice(0, ADDRESSES_TRIED)) {
      const outcome = await deps
        .reachesGateway(host, address)
        .catch((): PublicProbeOutcome => 'cannot-check');
      if (outcome !== 'cannot-check') {
        return outcome;
      }
    }
    return 'cannot-check';
  };
}
