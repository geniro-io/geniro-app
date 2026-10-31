import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { Transform } from 'node:stream';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

export type ContentEncoding = 'br' | 'gzip';

/**
 * Bodies below this are sent as they are: the frame and the dictionary cost
 * more than they save, and the phone's small reads (`/health`, a run row) are
 * most of its requests.
 */
export const MIN_COMPRESSIBLE_BYTES = 1024;

/**
 * Brotli's default quality is 11, which spends seconds on a multi-megabyte
 * transcript page; 4 is close to gzip's speed and still a third smaller.
 */
const BROTLI_QUALITY = 4;

const COMPRESSIBLE_TYPE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;

/**
 * The encoding to answer with, from the client's `Accept-Encoding`: brotli
 * when it is offered, else gzip, else none.
 */
export function negotiateEncoding(
  accept: IncomingHttpHeaders['accept-encoding'],
): ContentEncoding | null {
  const offered = new Map<string, number>();
  for (const part of (accept ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)) {
    const [name = '', ...params] = part.split(';').map((piece) => piece.trim());
    const q = params
      .map((param) => /^q=([\d.]+)$/.exec(param)?.[1])
      .find((value) => value !== undefined);
    offered.set(name, q === undefined ? 1 : Number(q));
  }
  const accepts = (name: ContentEncoding): boolean =>
    (offered.get(name) ?? offered.get('*') ?? 0) > 0;
  if (accepts('br')) {
    return 'br';
  }
  return accepts('gzip') ? 'gzip' : null;
}

/** Whether a response carries a body at all, which HEAD, 204 and 304 never do. */
export function hasBody(method: string | undefined, status: number): boolean {
  return method !== 'HEAD' && status >= 200 && status !== 204 && status !== 304;
}

/**
 * Whether a response with these headers is worth compressing: a text-like
 * type, not already encoded, and not known to be tiny. An event stream is
 * excluded because a compressor holds bytes back until it has enough to
 * emit, which would stall every event.
 */
export function isCompressible(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders,
): boolean {
  const type = headers['content-type'];
  if (typeof type !== 'string' || !COMPRESSIBLE_TYPE.test(type)) {
    return false;
  }
  if (headers['content-encoding'] !== undefined) {
    return false;
  }
  const length = Number(headers['content-length']);
  return !(Number.isFinite(length) && length < MIN_COMPRESSIBLE_BYTES);
}

export function createCompressor(encoding: ContentEncoding): Transform {
  return encoding === 'br'
    ? createBrotliCompress({
        params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      })
    : createGzip();
}

/**
 * The response headers once the body is encoded: the length the upstream
 * named no longer holds, and a cache in between must key on what the client
 * accepted.
 */
export function encodedHeaders(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders,
  encoding: ContentEncoding,
): OutgoingHttpHeaders {
  const { 'content-length': _length, vary, ...rest } = headers;
  const varyList = (Array.isArray(vary) ? vary.join(',') : (vary ?? ''))
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (
    !varyList.some(
      (token) => token === '*' || token.toLowerCase() === 'accept-encoding',
    )
  ) {
    varyList.push('Accept-Encoding');
  }
  return {
    ...rest,
    'content-encoding': encoding,
    vary: varyList.join(', '),
  };
}
