import { describe, expect, it } from 'vitest';

import {
  encodedHeaders,
  hasBody,
  isCompressible,
  MIN_COMPRESSIBLE_BYTES,
  negotiateEncoding,
} from './compression';

describe('negotiateEncoding', () => {
  it('prefers brotli, falls back to gzip, and answers null for neither', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
    expect(negotiateEncoding('deflate')).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
    expect(negotiateEncoding('')).toBeNull();
  });

  it('honours a refusal by q=0 and a wildcard', () => {
    expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip;q=0')).toBeNull();
    expect(negotiateEncoding('*')).toBe('br');
    expect(negotiateEncoding('*, br;q=0')).toBe('gzip');
    expect(negotiateEncoding('gzip, BR;q=0.5')).toBe('br');
  });
});

describe('hasBody', () => {
  it('is false for HEAD, 204 and 304, true for an ordinary answer', () => {
    expect(hasBody('GET', 200)).toBe(true);
    expect(hasBody('POST', 404)).toBe(true);
    expect(hasBody('HEAD', 200)).toBe(false);
    expect(hasBody('GET', 204)).toBe(false);
    expect(hasBody('GET', 304)).toBe(false);
  });
});

describe('isCompressible', () => {
  it('takes text-like types and leaves pictures, encoded bodies and event streams alone', () => {
    expect(isCompressible({ 'content-type': 'application/json' })).toBe(true);
    expect(
      isCompressible({ 'content-type': 'text/javascript; charset=utf-8' }),
    ).toBe(true);
    expect(isCompressible({ 'content-type': 'image/svg+xml' })).toBe(true);
    expect(isCompressible({ 'content-type': 'image/png' })).toBe(false);
    expect(isCompressible({})).toBe(false);
    expect(isCompressible({ 'content-type': 'text/event-stream' })).toBe(false);
    expect(
      isCompressible({
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      }),
    ).toBe(false);
  });

  it('skips a body known to be smaller than the threshold', () => {
    const small = String(MIN_COMPRESSIBLE_BYTES - 1);
    const large = String(MIN_COMPRESSIBLE_BYTES);
    expect(
      isCompressible({
        'content-type': 'application/json',
        'content-length': small,
      }),
    ).toBe(false);
    expect(
      isCompressible({
        'content-type': 'application/json',
        'content-length': large,
      }),
    ).toBe(true);
  });
});

describe('encodedHeaders', () => {
  it('drops the length, names the encoding and adds Accept-Encoding to Vary once', () => {
    expect(
      encodedHeaders(
        {
          'content-type': 'application/json',
          'content-length': '5000',
          vary: 'Origin',
        },
        'gzip',
      ),
    ).toEqual({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      vary: 'Origin, Accept-Encoding',
    });
    expect(encodedHeaders({ vary: 'accept-encoding' }, 'br').vary).toBe(
      'accept-encoding',
    );
  });
});
