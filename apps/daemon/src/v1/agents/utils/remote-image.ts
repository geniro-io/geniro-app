import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import {
  type IncomingMessage,
  request as httpRequest,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import type { AttachmentMediaType } from '../chat.types';
import { megabytes, sniffImageExtension } from './artifact-image-policy';

export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

const MAX_REDIRECTS = 3;

/** A downloaded picture, typed by its bytes. */
export interface RemoteImage {
  readonly mediaType: AttachmentMediaType;
  readonly bytes: Buffer;
}

/**
 * Why a download was refused or failed. The message is shown to the agent and
 * names only the URL it sent, never anything about this machine.
 */
export class RemoteImageError extends Error {}

export type ResolveAll = (
  hostname: string,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

export interface RemoteImageOptions {
  /** DNS resolution (test seam); default `dns.lookup` with `all: true`. */
  resolve?: ResolveAll;
  /** Which addresses may be connected to (test seam); default public only. */
  isAllowedAddress?: (address: string) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Ends the download early; it is then refused with `abortReason`. */
  signal?: AbortSignal;
  abortReason?: string;
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
// NAT64, 6to4 and Teredo carry an IPv4 address a gateway may translate to,
// which can be a private one, so those ranges are refused whole.
for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether an address is on the public internet. Loopback, private, link-local,
 * shared, multicast and reserved ranges are refused, so an agent-chosen URL can
 * never make the daemon reach this machine or its local network. An IPv4-mapped
 * IPv6 address is judged by the IPv4 address it carries.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const resolveAllDefault: ResolveAll = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, callback);

/**
 * A `lookup` for `http.request` that refuses a host when ANY of its addresses
 * is not allowed. Judging the addresses the socket is about to use, rather than
 * resolving once beforehand, is what keeps a DNS answer that changes between a
 * check and the connect from reaching a private address.
 */
export function guardedLookup(
  isAllowed: (address: string) => boolean,
  resolve: ResolveAll = resolveAllDefault,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error !== null) {
        callback(error, '', 0);
        return;
      }
      if (
        addresses.length === 0 ||
        addresses.some((entry) => !isAllowed(entry.address))
      ) {
        callback(
          new RemoteImageError(`${hostname} is not a public internet host`),
          '',
          0,
        );
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const wanted =
        options.family === 4 || options.family === 'IPv4'
          ? 4
          : options.family === 6 || options.family === 'IPv6'
            ? 6
            : 0;
      const pick =
        addresses.find((entry) => wanted === 0 || entry.family === wanted) ??
        addresses[0]!;
      callback(null, pick.address, pick.family);
    });
  };
}

/** Whether a string names a picture on the web rather than a file. */
export function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Download one picture an agent named by URL.
 *
 * Only `http:` and `https:`, no credentials in the URL, every hop's host judged
 * by {@link guardedLookup} (an IP literal is judged directly, since a socket
 * never looks one up), at most {@link MAX_REDIRECTS} redirects, a deadline over
 * the whole download and a byte ceiling counted as it streams. The type is
 * decided by the bytes, never the URL or the server's `Content-Type`.
 */
export async function downloadRemoteImage(
  url: string,
  options: RemoteImageOptions = {},
): Promise<RemoteImage> {
  const isAllowed = options.isAllowedAddress ?? isPublicAddress;
  const maxBytes = options.maxBytes ?? MAX_REMOTE_IMAGE_BYTES;
  const deadline = AbortSignal.timeout(
    options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS,
  );
  const signal =
    options.signal === undefined
      ? deadline
      : AbortSignal.any([deadline, options.signal]);
  const lookup = guardedLookup(isAllowed, options.resolve);
  try {
    let target = remoteTarget(url, isAllowed);
    for (let hop = 0; ; hop += 1) {
      const response = await get(target, lookup, signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        response.destroy();
        if (hop === MAX_REDIRECTS) {
          throw new RemoteImageError('too many redirects');
        }
        target = remoteTarget(new URL(location, target).href, isAllowed);
        continue;
      }
      if (status !== 200) {
        response.destroy();
        throw new RemoteImageError(`the server answered HTTP ${status}`);
      }
      const bytes = await readCapped(response, maxBytes);
      const extension = sniffImageExtension(bytes);
      const mediaType =
        extension === null || extension === 'avif'
          ? null
          : REMOTE_IMAGE_MEDIA_TYPE[extension];
      if (mediaType === null) {
        throw new RemoteImageError('not a png, jpeg, gif or webp image');
      }
      return { mediaType, bytes };
    }
  } catch (error) {
    if (error instanceof RemoteImageError) {
      throw error;
    }
    if (options.signal?.aborted === true) {
      throw new RemoteImageError(
        options.abortReason ?? 'the download was stopped',
      );
    }
    if (signal.aborted) {
      throw new RemoteImageError('the download timed out');
    }
    // The code only: a socket or TLS message can carry this machine's own
    // addresses, and the reason goes to a model off this machine.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new RemoteImageError(
      typeof code === 'string'
        ? `the download failed (${code})`
        : 'the download failed',
    );
  }
}

const REMOTE_IMAGE_MEDIA_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const satisfies Record<string, AttachmentMediaType>;

function remoteTarget(
  raw: string,
  isAllowed: (address: string) => boolean,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteImageError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteImageError('only http and https URLs are downloaded');
  }
  if (url.username !== '' || url.password !== '') {
    throw new RemoteImageError('a URL carrying credentials is not downloaded');
  }
  const literal = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(literal) !== 0 && !isAllowed(literal)) {
    throw new RemoteImageError(`${literal} is not a public internet address`);
  }
  return url;
}

function get(
  target: URL,
  lookup: LookupFunction,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    method: 'GET',
    headers: { accept: 'image/*', 'user-agent': 'Geniro' },
    lookup,
    signal,
    agent: false,
  };
  return new Promise((resolve, reject) => {
    const request = send(target, options, resolve);
    request.on('error', reject);
    request.end();
  });
}

async function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const tooLarge = (): RemoteImageError =>
    new RemoteImageError(
      `larger than the ${megabytes(maxBytes)}MB a gallery downloads`,
    );
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw tooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
