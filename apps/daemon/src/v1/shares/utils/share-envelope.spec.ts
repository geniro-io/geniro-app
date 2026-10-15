import { createDecipheriv } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ARTIFACT_PAGE_CSP } from '../../agents/utils/artifact-page';
import { buildShareEnvelope, mintShareKey } from './share-envelope';

const SECRET_PAGE =
  '<!DOCTYPE html><html><head><title>Quarterly numbers</title></head><body><p>revenue-marker-7731</p></body></html>';

function payloadOf(envelope: string): { iv: string; ct: string } {
  const match =
    /<script id="payload" type="application\/json">([^<]*)<\/script>/.exec(
      envelope,
    );
  if (!match) {
    throw new Error('no payload');
  }
  return JSON.parse(match[1] ?? '') as { iv: string; ct: string };
}

function decrypt(
  envelope: string,
  key: string,
  aad = 'geniro-share-v1',
): string {
  const { iv, ct } = payloadOf(envelope);
  const data = Buffer.from(ct, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

describe('buildShareEnvelope', () => {
  it('round-trips the page through the key, and only through that key', () => {
    const key = mintShareKey();
    const envelope = buildShareEnvelope(SECRET_PAGE, key);

    expect(decrypt(envelope, key)).toBe(SECRET_PAGE);
    expect(() => decrypt(envelope, mintShareKey())).toThrow();
  });

  it('binds the format version, so a payload decrypts only as the version it was written for', () => {
    const key = mintShareKey();
    expect(() =>
      decrypt(buildShareEnvelope(SECRET_PAGE, key), key, 'geniro-share-v2'),
    ).toThrow();
  });

  it('stores nothing of the page in the clear — neither its text nor its title', () => {
    const envelope = buildShareEnvelope(SECRET_PAGE, mintShareKey());

    expect(envelope).not.toContain('revenue-marker-7731');
    expect(envelope).not.toContain('Quarterly numbers');
  });

  it('uses a fresh IV on every upload, so re-sharing never repeats a nonce under one key', () => {
    const key = mintShareKey();
    expect(payloadOf(buildShareEnvelope(SECRET_PAGE, key)).iv).not.toBe(
      payloadOf(buildShareEnvelope(SECRET_PAGE, key)).iv,
    );
  });

  it('frames the decrypted page under the artifact policy and sends no referrer', () => {
    const envelope = buildShareEnvelope(SECRET_PAGE, mintShareKey());

    expect(envelope).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PAGE_CSP}">`,
    );
    expect(envelope).toContain('<meta name="referrer" content="no-referrer">');
    expect(envelope).toContain("'sandbox', 'allow-scripts allow-popups");
    expect(envelope).not.toContain('allow-same-origin');
  });

  it('refuses a key of the wrong length rather than encrypting under it', () => {
    expect(() =>
      buildShareEnvelope(SECRET_PAGE, Buffer.alloc(16).toString('base64url')),
    ).toThrow(/32 bytes/);
  });
});

describe('mintShareKey', () => {
  it('mints a 256-bit key as the 43-character base64url the link carries', () => {
    const key = mintShareKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, 'base64url')).toHaveLength(32);
  });
});
