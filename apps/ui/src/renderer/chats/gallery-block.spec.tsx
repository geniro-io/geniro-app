// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { GalleryCard } from './gallery-block';
import type { GallerySpec } from './gallery-payload';
import { LocalImageLoaderContext } from './local-image-loader';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The full-screen viewer a tile opens carries the zoom layer, which needs one.
stubResizeObserver();

const GALLERY: GallerySpec = {
  title: 'Before and after',
  images: [
    { path: '/tmp/a.png', caption: 'the old header' },
    { path: '/tmp/b.png', caption: null },
    { path: '/tmp/c.png', caption: null },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Renders the card under a loader, and drains the sequential load walk. */
async function render(
  gallery: GallerySpec,
  load: (path: string) => Promise<string> = async (path) =>
    `data:image/png;base64,${path}`,
): Promise<void> {
  await act(async () => {
    root.render(
      <LocalImageLoaderContext.Provider value={load}>
        <GalleryCard gallery={gallery} />
      </LocalImageLoaderContext.Provider>,
    );
  });
  // The walk resolves one picture per microtask turn, so one flush per image
  // plus a margin drains it.
  for (let i = 0; i < gallery.images.length + 2; i += 1) {
    await act(async () => {});
  }
}

const tiles = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>(
    '[data-slot="gallery-tile"]',
  ),
];

/** The viewer is portalled, so it is looked for on the DOCUMENT. */
const viewer = (): HTMLImageElement | null =>
  document.body.querySelector('[data-slot="image-viewer-image"]');

const control = (label: string): HTMLButtonElement | null =>
  document.body.querySelector(`[aria-label="${label}"]`);

function press(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('a gallery an agent handed over', () => {
  it('draws one tile per image, resolved through the shared loader', async () => {
    const asked: string[] = [];
    await render(GALLERY, async (path) => {
      asked.push(path);
      return `data:image/png;base64,${path}`;
    });

    expect(tiles()).toHaveLength(3);
    // Through the SAME loader a markdown image uses, over the same daemon
    // route — not a second fetch path of this card's own.
    expect(asked).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']);
    expect(
      container.querySelector<HTMLImageElement>('[data-slot="gallery-image"]')
        ?.src,
    ).toContain('/tmp/a.png');
  });

  it('opens the shared full-screen viewer when a tile is pressed', async () => {
    await render(GALLERY);

    expect(viewer()).toBeNull();
    press(tiles()[0]!);

    // The app's ONE image surface — same `data-slot` the single-image viewer
    // uses — rather than a lightbox of the gallery's own.
    expect(viewer()).not.toBeNull();
    expect(viewer()?.getAttribute('src')).toContain('/tmp/a.png');
  });

  it('steps between pictures, and says where in the set it is', async () => {
    await render(GALLERY);
    press(tiles()[0]!);

    expect(document.body.textContent).toContain('1 of 3');

    press(control('Next image')!);

    expect(viewer()?.getAttribute('src')).toContain('/tmp/b.png');
    expect(document.body.textContent).toContain('2 of 3');
  });

  it('withholds the arrow at each end rather than wrapping round', async () => {
    // A set has a first and a last picture; looping silently makes a reader
    // stepping through lose their place in it.
    await render(GALLERY);

    press(tiles()[0]!);
    expect(control('Previous image')!.disabled).toBe(true);
    expect(control('Next image')!.disabled).toBe(false);

    press(control('Next image')!);
    press(control('Next image')!);

    expect(viewer()?.getAttribute('src')).toContain('/tmp/c.png');
    expect(control('Next image')!.disabled).toBe(true);
    expect(control('Previous image')!.disabled).toBe(false);
  });

  it('REMOUNTS the zoom layer on each picture rather than reusing it', async () => {
    // What `key={src}` buys. Without it React reuses the same subtree and the
    // next picture inherits the previous one's scale and offset — opening
    // already zoomed into a corner of the last one. Scale is unobservable under
    // jsdom, but the remount itself is: element IDENTITY is the real signal.
    await render(GALLERY);
    press(tiles()[0]!);
    const before = viewer();

    press(control('Next image')!);

    expect(viewer()).not.toBeNull();
    expect(viewer()).not.toBe(before);
  });

  it('refuses a REMOTE path itself, without asking the loader', async () => {
    // The renderer's own first door. The daemon has a second one, so deleting
    // this still fails the tile — just with a generic message instead of the
    // reason, and only after an outbound-shaped request was composed.
    const asked: string[] = [];
    await render(
      {
        title: null,
        images: [
          { path: '/tmp/a.png', caption: null },
          { path: 'https://example.com/pixel.png', caption: null },
        ],
      },
      async (path) => {
        asked.push(path);
        return `data:image/png;base64,${path}`;
      },
    );

    expect(asked).toEqual(['/tmp/a.png']);
    expect(container.textContent).toContain('remote images are not loaded');
    expect(tiles()[1]!.disabled).toBe(true);
  });

  it('walks the set with the arrow KEYS as well as the buttons', async () => {
    await render(GALLERY);
    press(tiles()[0]!);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });

    expect(viewer()?.getAttribute('src')).toContain('/tmp/b.png');
  });

  it('shows a picture that could not be read as one dead tile, not a dead card', async () => {
    // The defensive branch, entered deliberately: a path that has moved costs
    // its own tile and nothing else, because the agent produced the rest and
    // refusing to draw them would hide the work over one file.
    await render(GALLERY, async (path) => {
      if (path === '/tmp/b.png') {
        throw new Error('ENOENT');
      }
      return `data:image/png;base64,${path}`;
    });

    expect(container.textContent).toContain('could not be read');
    // The other two still drew.
    expect(
      container.querySelectorAll('[data-slot="gallery-image"]'),
    ).toHaveLength(2);
    // And the dead one cannot be opened onto nothing.
    expect(tiles()[1]!.disabled).toBe(true);
    expect(tiles()[0]!.disabled).toBe(false);
  });

  it('releases the pictures it holds once the card is folded away', async () => {
    // Every resolved picture is a `data:` URL held in memory, and a thread can
    // hold several galleries in an unvirtualized transcript — so a folded card
    // must not go on holding 24 of them. Reopening reads them again, which is
    // the deliberate trade: bounded memory over a second round trip.
    let reads = 0;
    await render(GALLERY, async (path) => {
      reads += 1;
      return `data:image/png;base64,${path}`;
    });
    expect(reads).toBe(3);
    expect(
      container.querySelectorAll('[data-slot="gallery-image"]'),
    ).toHaveLength(3);

    const disclosure =
      container.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    press(disclosure);
    press(disclosure);
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {});
    }

    // Read again — which is only observable because the map was actually let go.
    expect(reads).toBe(6);
    expect(
      container.querySelectorAll('[data-slot="gallery-image"]'),
    ).toHaveLength(3);
  });

  it('says so, rather than reading "loading…" forever, with no loader in context', async () => {
    // Outside a provider nothing will ever resolve, so a permanent spinner-text
    // would be the app quietly waiting on something that is not coming.
    await act(async () => {
      root.render(<GalleryCard gallery={GALLERY} />);
    });

    expect(container.textContent).not.toContain('loading…');
    expect(container.textContent).toContain('no image loader');
    expect(tiles().every((tile) => tile.disabled)).toBe(true);
  });

  it('steps OVER a picture that could not be read instead of vanishing', async () => {
    // The viewer only renders while it holds a drawable image, so navigation
    // that lands on an unreadable one would drop the dialog out from under the
    // reader mid-step — a modal that disappears with nothing said. A dead tile
    // is skipped, exactly as the grid refuses to open one.
    await render(GALLERY, async (path) => {
      if (path === '/tmp/b.png') {
        throw new Error('ENOENT');
      }
      return `data:image/png;base64,${path}`;
    });

    press(tiles()[0]!);
    expect(viewer()).not.toBeNull();

    press(control('Next image')!);

    expect(viewer()).not.toBeNull();
    expect(viewer()?.getAttribute('src')).toContain('/tmp/c.png');
  });

  it('loads ONE picture at a time, not the whole set at once', async () => {
    // The sequential walk is what bounds how many 20MB `data:` URLs are in
    // flight together. Asserting the finished order proves nothing — a
    // `Promise.all(paths.map(load))` produces the identical order — so this
    // holds each load open and checks nothing else was asked for meanwhile.
    const asked: string[] = [];
    const release: ((url: string) => void)[] = [];
    await act(async () => {
      root.render(
        <LocalImageLoaderContext.Provider
          value={async (path) => {
            asked.push(path);
            return new Promise<string>((resolve) => release.push(resolve));
          }}>
          <GalleryCard gallery={GALLERY} />
        </LocalImageLoaderContext.Provider>,
      );
    });

    expect(asked).toEqual(['/tmp/a.png']);

    await act(async () => release[0]!('data:image/png;base64,a'));
    expect(asked).toEqual(['/tmp/a.png', '/tmp/b.png']);

    await act(async () => release[1]!('data:image/png;base64,b'));
    expect(asked).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']);
  });

  it('abandons the walk when the card is folded away mid-load', async () => {
    // The `live` flag. Without it a collapsed card goes on reading files
    // nobody is looking at — and on a set of 24 that is 24 daemon round trips
    // spent after the reader closed it.
    const asked: string[] = [];
    const release: ((url: string) => void)[] = [];
    await act(async () => {
      root.render(
        <LocalImageLoaderContext.Provider
          value={async (path) => {
            asked.push(path);
            return new Promise<string>((resolve) => release.push(resolve));
          }}>
          <GalleryCard gallery={GALLERY} />
        </LocalImageLoaderContext.Provider>,
      );
    });
    expect(asked).toEqual(['/tmp/a.png']);

    press(container.querySelector<HTMLButtonElement>('[aria-expanded]')!);
    await act(async () => release[0]!('data:image/png;base64,a'));
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {});
    }

    // The first load settled, and the walk did NOT go on to the second.
    expect(asked).toEqual(['/tmp/a.png']);
  });

  it('steps backwards with ArrowLeft, and stops listening once closed', async () => {
    await render(GALLERY);
    press(tiles()[1]!);
    expect(viewer()?.getAttribute('src')).toContain('/tmp/b.png');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    expect(viewer()?.getAttribute('src')).toContain('/tmp/a.png');

    // Closed, the document listener must be gone — otherwise a stray arrow
    // walks a set nobody is looking at, and the viewer reopens on the next
    // render carrying an index the reader never chose.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(viewer()).toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(viewer()).toBeNull();
  });

  it('heads the card with the agent’s title and the count', async () => {
    await render(GALLERY);

    expect(container.textContent).toContain('Before and after');
    expect(container.textContent).toContain('3 images');
  });

  it('counts a single image in the singular', async () => {
    await render({
      title: null,
      images: [{ path: '/tmp/a.png', caption: null }],
    });

    expect(container.textContent).toContain('1 image');
    expect(container.textContent).not.toContain('1 images');
  });
});
