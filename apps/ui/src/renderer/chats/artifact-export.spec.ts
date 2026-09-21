// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactFileName, buildArtifactFile } from './artifact-export';
import type { PublishedArtifact } from './published-artifact';

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

  it('puts the block inside the head, before the page closes it', async () => {
    const file = await buildArtifactFile(
      'http://127.0.0.1:1/x',
      serves('<html><head><title>p</title></head><body>x</body></html>'),
    );

    expect(file.indexOf('<title>p</title>')).toBeLessThan(
      file.indexOf('data-geniro="theme"'),
    );
    expect(file.indexOf('data-geniro="theme"')).toBeLessThan(
      file.indexOf('</head>'),
    );
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

  it('keeps the agent’s document otherwise byte for byte', async () => {
    const page = '<html><head></head><body><p>exactly this</p></body></html>';

    const file = await buildArtifactFile('http://127.0.0.1:1/x', serves(page));

    expect(
      file.replace(/<style data-geniro="theme">[\s\S]*?<\/style>\n/, ''),
    ).toBe(page);
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
