import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const INDEX_HTML = readFileSync(join(__dirname, 'index.html'), 'utf8');
const GLOBAL_CSS = readFileSync(join(__dirname, 'styles/global.css'), 'utf8');

/**
 * The page a phone opens over the LAN gateway. Electron ignores the viewport
 * tag, so none of this is reachable from the desktop and jsdom lays nothing
 * out — the declarations themselves are what can regress.
 */
describe('the phone viewport', () => {
  it('leaves pinch-zoom alone', () => {
    // Android Chrome and Samsung Internet honour a scale cap, so a paired
    // Android phone could not zoom at all while it was set.
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(
      INDEX_HTML,
    );
    expect(viewport?.[1]).toBe('width=device-width, initial-scale=1.0');
  });

  it('draws the markdown editor at 16px on a phone, where iOS would zoom into it', () => {
    // With the cap gone, the one field whose size the vendor pins with
    // !important needs its own rule — the field primitives carry
    // `max-sm:text-[16px]`. A literal 16px: `--text-base` is 1rem, and this
    // app's rem is 15px, so the first version of this rule still zoomed.
    const rule =
      /@media \(width < 40rem\)\s*\{\s*\.md-editor-surface \.w-md-editor-text,\s*\.md-editor-surface \.w-md-editor-text-pre > code\s*\{([^}]*)\}/.exec(
        GLOBAL_CSS,
      );
    expect(rule?.[1]).toContain('font-size: 16px !important');
  });

  it('lets the page frame an artifact served from its own origin', () => {
    // On a phone `daemonBaseUrl` is the gateway's (or the tunnel's) origin, so
    // an artifact frame is same-origin; with loopback alone the browser
    // refused it and the card stayed white.
    const csp =
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(
        INDEX_HTML,
      )?.[1];
    const frameSrc = csp
      ?.split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === 'frame-src');
    expect(frameSrc).toContain("'self'");
    expect(frameSrc).toContain('http://127.0.0.1:*');
  });
});
