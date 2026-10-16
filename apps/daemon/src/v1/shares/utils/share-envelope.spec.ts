import { createDecipheriv, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

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

interface OpenedEnvelope {
  notice: { textContent: string; hidden: boolean };
  frame: { srcdoc?: string } | undefined;
  replacedUrls: string[];
}

/** Runs the envelope's own decrypt script against a minimal browser stand-in. */
function openEnvelope(envelope: string, hash: string): OpenedEnvelope {
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(envelope)?.[1];
  if (script === undefined) {
    throw new Error('no decrypt script');
  }
  const opened: OpenedEnvelope = {
    notice: { textContent: '', hidden: true },
    frame: undefined,
    replacedUrls: [],
  };
  const payload = { textContent: JSON.stringify(payloadOf(envelope)) };
  const browser = {
    window: { isSecureContext: true, crypto: webcrypto, TextDecoder },
    crypto: webcrypto,
    TextDecoder,
    TextEncoder,
    atob,
    location: { hash, pathname: '/pr-reports/abc/index.html', search: '?x=1' },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        opened.replacedUrls.push(url);
      },
    },
    document: {
      getElementById: (id: string) =>
        id === 'notice' ? opened.notice : id === 'payload' ? payload : null,
      createElement: () => ({ setAttribute: () => undefined }),
      body: {
        appendChild: (frame: { srcdoc?: string }) => {
          opened.frame = frame;
        },
      },
    },
  };
  runInNewContext(script, browser);
  return opened;
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

  it('decrypts in the reader’s browser and takes the key out of the address bar', async () => {
    const key = mintShareKey();
    const page = openEnvelope(
      buildShareEnvelope(SECRET_PAGE, key),
      `#k=${key}`,
    );

    await vi.waitFor(() => expect(page.frame?.srcdoc).toBe(SECRET_PAGE));
    expect(page.replacedUrls).toEqual(['/pr-reports/abc/index.html?x=1']);
    expect(page.notice.hidden).toBe(true);
  });

  it('leaves the address alone and says so when the link carries no key', () => {
    const page = openEnvelope(
      buildShareEnvelope(SECRET_PAGE, mintShareKey()),
      '',
    );

    expect(page.notice.hidden).toBe(false);
    expect(page.notice.textContent).toContain('missing its key');
    expect(page.replacedUrls).toEqual([]);
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
