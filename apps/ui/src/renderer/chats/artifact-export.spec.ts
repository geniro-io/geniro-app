// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_FILE_CSP,
  ARTIFACT_LAYER_ORDER,
  artifactFileName,
  buildArtifactFile,
} from './artifact-export';
import type { PublishedArtifact } from './published-artifact';

/** Read a saved file back the way a browser opening it would. */
const parse = (file: string): Document =>
  new DOMParser().parseFromString(file, 'text/html');

function artifact(over: Partial<PublishedArtifact> = {}): PublishedArtifact {
  return {
    artifactId: 'workspaces-plan',
    version: 2,
    title: 'Workspaces — cross-repo boards',
    summary: null,
    key: 'k'.repeat(64),
    ...over,
  };
}

/** Answer the raw route with a document, as the daemon does. */
function serves(html: string): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(html),
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  // The values the block is built from — the frame reads these off the live
  // document, so a spec has to put them there. SENTINELS rather than colours:
  // a custom property carries arbitrary text, what is under test is that
  // whatever is resolved lands in the file, and a literal that looked like a
  // palette value would be both a worse assertion and a lint error.
  document.documentElement.style.setProperty('--foreground', 'sentinel-fg');
  document.documentElement.style.setProperty('--card', 'sentinel-surface');
});

afterEach(() => {
  // Specs here set tokens on the shared root; left behind they would decide
  // what the next spec's file bakes in.
  document.documentElement.removeAttribute('style');
});

describe('artifactFileName', () => {
  it('names the file after the artifact TITLE', () => {
    // Punctuation a file name may legally carry is KEPT — the shaping strips
    // what a path or a shell would act on, not everything that is not a
    // letter, and this is the same slug a chat export gets.
    expect(artifactFileName(artifact())).toBe('Workspaces-—-cross-repo-boards');
  });

  it('falls back to the artifact id when the title shapes away to nothing', () => {
    // A title of only separators has no usable name in it, and the id is the
    // one other thing on the row that always exists.
    expect(
      artifactFileName(artifact({ title: '///', artifactId: 'plan-v3' })),
    ).toBe('plan-v3');
  });

  it('carries no extension — main appends the one its filter opens on', () => {
    expect(artifactFileName(artifact())).not.toContain('.');
  });
});

describe('buildArtifactFile', () => {
  it('bakes the CURRENT theme in, so the file needs no host', () => {
    // The framed page is handed these over postMessage. A saved file is opened
    // by a double-click with nothing to hand it anything, so a var that is not
    // IN the document falls through to the page's own fallback — or, for a page
    // that wrote none, to nothing at all.
    return buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<html><head><title>p</title></head><body>x</body></html>'),
    ).then((file) => {
      expect(file).toContain('--geniro-fg: sentinel-fg;');
      expect(file).toContain('--geniro-surface: sentinel-surface;');
      expect(file).toContain(':root {');
    });
  });

  it('bakes EVERY token the tool description promises a page', async () => {
    // A chart or a status badge on a saved page reads these the same way the
    // framed page does; one missing from the map renders as its fallback. The
    // names are the show_artifact description's list, spelled out here so a
    // row dropped from THEME_TOKENS cannot drop out of the check with it.
    const promised: [string, string][] = [
      ['--geniro-fg', '--foreground'],
      ['--geniro-muted', '--muted-foreground'],
      ['--geniro-bg', '--background'],
      ['--geniro-surface', '--card'],
      ['--geniro-subtle', '--muted'],
      ['--geniro-border', '--border'],
      ['--geniro-primary', '--primary'],
      ['--geniro-primary-fg', '--primary-foreground'],
      ['--geniro-success', '--success'],
      ['--geniro-warning', '--warning'],
      ['--geniro-danger', '--destructive'],
      ['--geniro-chart-1', '--chart-1'],
      ['--geniro-chart-2', '--chart-2'],
      ['--geniro-chart-3', '--chart-3'],
      ['--geniro-chart-4', '--chart-4'],
      ['--geniro-chart-5', '--chart-5'],
      ['--geniro-radius', '--radius'],
      ['--geniro-font', '--font-family-sans'],
      ['--geniro-font-mono', '--font-family-mono'],
    ];
    const root = document.documentElement.style;
    for (const [, source] of promised) {
      root.setProperty(source, `sentinel${source}`);
    }

    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<html><head></head><body>x</body></html>'),
    );

    for (const [name, source] of promised) {
      expect(file).toContain(`${name}: sentinel${source};`);
    }
  });

  it('gives the document a GROUND, which only a standalone file needs', async () => {
    // In the app the wrapper makes the page transparent and the card behind
    // the frame supplies the colour. A saved file has nothing behind it, so
    // without this a page saved under a dark theme is near-white text on the
    // browser's default white. Found by opening a saved file in Chrome — it is
    // invisible from inside the app, where every rendering looks right.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<html><head></head><body>x</body></html>'),
    );

    expect(file).toContain('html, body { background: var(--geniro-bg);');
  });

  it('keeps that ground in the geniro-base LAYER, under the layer order', async () => {
    // Unlayered, the ground outranked every layered rule, so a body carrying a
    // Tailwind background utility kept it in the app and lost it in the file.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<html><head></head><body>x</body></html>'),
    );

    const theme = parse(file).head.querySelector('style[data-geniro="theme"]');
    const css = theme!.textContent!;
    expect(css).toMatch(
      /@layer geniro-base \{ html, body \{ background: var\(--geniro-bg\);/,
    );
    expect(css.indexOf(ARTIFACT_LAYER_ORDER)).toBeGreaterThan(-1);
    expect(css.indexOf(ARTIFACT_LAYER_ORDER)).toBeLessThan(
      css.indexOf('@layer geniro-base {'),
    );
  });

  it('states the SAME layer order the daemon’s page runtime does', () => {
    // A twin: the saved file's block comes first, so its order statement is
    // the one the document gets, and a different one would re-rank the kit
    // against Tailwind in the file alone.
    const source = readFileSync(
      join(
        __dirname,
        '../../../../daemon/src/v1/agents/utils/artifact-runtime.ts',
      ),
      'utf8',
    );
    const daemon = /ARTIFACT_LAYER_ORDER\s*=\s*'([^']+)'/.exec(source)?.[1];
    expect(daemon).toBe(ARTIFACT_LAYER_ORDER);
  });

  it('puts the block in the head AHEAD of the page’s own styles, so they win', async () => {
    // It is a BASE: a page that sets its own background or its own
    // `--geniro-*` values must keep them, and between two rules of one
    // specificity the later one wins.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves(
        '<html><head><title>p</title><style>body { background: tomato }</style></head><body>x</body></html>',
      ),
    );

    const head = parse(file).head;
    const theme = head.querySelector('style[data-geniro="theme"]');
    const own = [...head.querySelectorAll('style')].find(
      (node) => !node.hasAttribute('data-geniro'),
    );
    expect(theme).not.toBeNull();
    expect(
      theme!.compareDocumentPosition(own!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(head.querySelector('title')?.textContent).toBe('p');
  });

  it('never writes into the page’s own script, whatever it says about </head>', async () => {
    // Not spliced in before the FIRST `</head>` in the text: a page that builds
    // a printable copy of itself carries one inside a script string, well
    // before its real head ends (or with no head at all).
    const script =
      "function printable(){ var w = open(); w.document.write('<html><head><title>x</title></head><body>hi</body></html>'); }";
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves(`<body><script>${script}</script><p>page</p></body>`),
    );

    const doc = parse(file);
    expect(doc.querySelector('script')?.textContent).toBe(script);
    expect(doc.head.querySelector('style[data-geniro="theme"]')).not.toBeNull();
    expect(doc.body.querySelector('style[data-geniro="theme"]')).toBeNull();
  });

  it('carries the page’s own security policy, ahead of anything that runs', async () => {
    // In the app the policy is a response HEADER, and a file has none — so a
    // saved page opened by a double-click ran with no policy at all. A meta
    // policy governs only what comes AFTER it, hence ahead of the page's head.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves(
        '<html><head><script>window.early = 1</script></head><body>x</body></html>',
      ),
    );

    const head = parse(file).head;
    const policy = head.querySelector(
      'meta[http-equiv="Content-Security-Policy"]',
    );
    expect(policy?.getAttribute('content')).toBe(ARTIFACT_FILE_CSP);
    expect(
      policy!.compareDocumentPosition(head.querySelector('script')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      policy!.compareDocumentPosition(
        head.querySelector('style[data-geniro="theme"]')!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('declares the UTF-8 it is written in, first', async () => {
    // A browser looks for the charset only in the first bytes of a file, and
    // the blocks above push the page's own declaration further in. Main writes
    // the file as UTF-8 whatever the page claimed, so that is what is declared
    // — once, since a second, older declaration would contradict it.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves(
        '<html><head><title>t</title><meta charset="windows-1251"></head><body>Привет</body></html>',
      ),
    );

    const head = parse(file).head;
    expect(head.firstElementChild?.getAttribute('charset')).toBe('utf-8');
    expect(head.querySelectorAll('meta[charset]')).toHaveLength(1);
    expect(file).toContain('Привет');
  });

  it('is a standards-mode document', async () => {
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<p>a bare fragment</p>'),
    );

    expect(file.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('PREPENDS the block to a document with no head at all', async () => {
    // An agent may write a bare fragment. A custom property has to be declared
    // for `var()` to resolve it, so the block cannot simply be dropped.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<p>a bare fragment</p>'),
    );

    expect(file.indexOf('data-geniro="theme"')).toBeLessThan(
      file.indexOf('<p>a bare fragment</p>'),
    );
  });

  it('keeps the agent’s own markup and script text as written', async () => {
    // Re-serialized rather than spliced, so the promise is the CONTENT: a
    // script's text is never escaped or re-encoded on its way through.
    const script = "if (a < b && c > d) { el.innerHTML = '<b>&amp;</b>'; }";
    const page = `<html><head><title>t</title></head><body><p class="k">exactly this</p><script>${script}</script></body></html>`;

    const file = await buildArtifactFile('http://127.0.0.1:1/x', serves(page));

    expect(file).toContain('<p class="k">exactly this</p>');
    expect(file).toContain(`<script>${script}</script>`);
  });

  it('does NOT carry geniro’s frame wrapper', async () => {
    // It fetches the raw reading precisely so it does not: the wrapper is a
    // postMessage handshake with an embedder, and in a file opened on its own
    // it is dead code listening for a parent that never speaks.
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<html><head></head><body>x</body></html>'),
    );

    expect(file).not.toContain('geniro-artifact');
    expect(file).not.toContain('postMessage');
  });

  it('asks for the RAW reading of the page', async () => {
    const fetchImpl = serves('<html><head></head><body>x</body></html>');

    await buildArtifactFile('http://127.0.0.1:1/x?key=k&v=2&raw=1', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:1/x?key=k&v=2&raw=1',
    );
  });

  it('throws rather than saving a refusal as though it were the page', async () => {
    // The route answers 404 for a wrong key or a version it does not hold. A
    // body written to disk regardless would be a file named after the plan
    // containing the word "not found".
    const refuses = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve('not found'),
      }),
    ) as unknown as typeof fetch;

    await expect(
      buildArtifactFile('http://127.0.0.1:1/x', refuses),
    ).rejects.toThrow(/404/);
  });
});

describe('ARTIFACT_FILE_CSP', () => {
  it('is the policy the daemon serves the page under, word for word', () => {
    // A TWIN: the renderer cannot import daemon source, so the saved file's
    // policy is restated here. Read off the daemon's own file so the two
    // cannot drift apart silently — a saved page must not be allowed more
    // than the framed one is.
    const source = readFileSync(
      join(
        __dirname,
        '../../../../daemon/src/v1/agents/utils/artifact-page.ts',
      ),
      'utf8',
    );
    const array =
      /export const ARTIFACT_PAGE_CSP = \[([\s\S]*?)\]\.join\('; '\);/.exec(
        source,
      );
    expect(array).not.toBeNull();
    const directives = [...array![1]!.matchAll(/(["'])(.*?)\1,?/g)].map(
      (match) => match[2],
    );

    expect(directives.length).toBeGreaterThan(0);
    expect(ARTIFACT_FILE_CSP).toBe(directives.join('; '));
  });
});
