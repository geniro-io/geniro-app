import { createCipheriv, randomBytes } from 'node:crypto';

import { ARTIFACT_PAGE_CSP } from '../../agents/utils/artifact-page';

/** Bytes in a share key (AES-256). */
const SHARE_KEY_BYTES = 32;

/**
 * Bound into every ciphertext as GCM additional data, so a payload written for
 * another format version can never decrypt as this one.
 */
const SHARE_AAD = 'geniro-share-v1';

/** A fresh share key, base64url — the form the link's `#k=` carries. */
export function mintShareKey(): string {
  return randomBytes(SHARE_KEY_BYTES).toString('base64url');
}

/**
 * The page the destination stores: a fixed, geniro-written template holding
 * the artifact ONLY as AES-256-GCM ciphertext, plus the script that decrypts
 * it in the reader's browser with the key from the link's `#fragment`. A
 * browser never sends the fragment, so the host stores and serves ciphertext
 * it cannot read.
 *
 * The decrypted page is shown in an `<iframe sandbox srcdoc>`, which inherits
 * this document's policy — the same `ARTIFACT_PAGE_CSP` the app frames
 * artifacts under, so a shared page can load exactly the CDN libraries it
 * could in the app and reach nothing else.
 *
 * Nothing about the artifact is in the clear: not its title, not its size
 * beyond the ciphertext length.
 */
export function buildShareEnvelope(html: string, key: string): string {
  const keyBytes = Buffer.from(key, 'base64url');
  if (keyBytes.length !== SHARE_KEY_BYTES) {
    throw new Error('a share key is 32 bytes');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
  cipher.setAAD(Buffer.from(SHARE_AAD, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(html, 'utf8'),
    cipher.final(),
    // WebCrypto expects the tag appended to the ciphertext.
    cipher.getAuthTag(),
  ]);
  const payload = JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    ct: ciphertext.toString('base64url'),
  });
  return ENVELOPE_TEMPLATE.replace('__PAYLOAD__', () => payload);
}

const NOTICE_MISSING_KEY =
  'This link is missing its key. Open the original link again — if you had to sign in first, the sign-in may have dropped the part after #.';
const NOTICE_WRONG_KEY =
  'This page could not be opened: the key in the link does not match. It may have been copied incompletely.';
const NOTICE_INSECURE =
  'This page can only be opened over https in a current browser.';

const DECRYPT_SCRIPT = `
(function () {
  var notice = document.getElementById('notice');
  function show(text) { notice.textContent = text; notice.hidden = false; }
  if (!window.isSecureContext || !window.crypto || !window.crypto.subtle || !window.TextDecoder) {
    show(${JSON.stringify(NOTICE_INSECURE)});
    return;
  }
  var match = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  if (!match) {
    show(${JSON.stringify(NOTICE_MISSING_KEY)});
    return;
  }
  function bytes(text) {
    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  var payload = JSON.parse(document.getElementById('payload').textContent);
  crypto.subtle
    .importKey('raw', bytes(match[1]), { name: 'AES-GCM' }, false, ['decrypt'])
    .then(function (key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(payload.iv), additionalData: new TextEncoder().encode(${JSON.stringify(SHARE_AAD)}) },
        key,
        bytes(payload.ct)
      );
    })
    .then(
      function (plain) {
        var frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
        frame.setAttribute('title', 'Shared page');
        frame.srcdoc = new TextDecoder().decode(plain);
        document.body.appendChild(frame);
      },
      function () { show(${JSON.stringify(NOTICE_WRONG_KEY)}); }
    );
})();
`;

const ENVELOPE_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PAGE_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared page</title>
<style>
html, body { margin: 0; height: 100%; background: #fff; }
iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
#notice { max-width: 560px; margin: 15vh auto; padding: 0 24px; font: 15px/1.5 -apple-system, system-ui, sans-serif; color: #333; }
</style>
</head>
<body>
<p id="notice" hidden></p>
<script id="payload" type="application/json">__PAYLOAD__</script>
<script>${DECRYPT_SCRIPT}</script>
</body>
</html>
`;
