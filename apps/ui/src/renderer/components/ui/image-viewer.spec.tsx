// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stubResizeObserver } from '../../__tests__/stub-resize-observer';
import { ZoomableImage, zoomControlState } from './image-viewer';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The zoom layer observes its container to know the bounds it clamps panning
// to. Every box still measures 0×0 here, so no test below asserts a SCALE —
// they pin the controls and the invariants around them.
stubResizeObserver();

const SRC = 'data:image/png;base64,AAA';

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

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

const thumbnail = (): HTMLButtonElement | null =>
  container.querySelector('[data-slot="zoomable-image"]');

/** The viewer is portalled, so it is looked for on the DOCUMENT, not in `container`. */
const viewer = (): HTMLImageElement | null =>
  document.body.querySelector('[data-slot="image-viewer-image"]');

/** A zoom control by its accessible name — portalled with the viewer. */
const control = (label: string): HTMLButtonElement | null =>
  document.body.querySelector(
    `[data-slot="image-viewer-controls"] [aria-label="${label}"]`,
  );

function press(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('what the zoom controls offer at a given magnification', () => {
  // The component test below can only ever observe the RESTING state: jsdom
  // measures every box 0×0, so the library never leaves scale 1 there. These
  // drive the decision itself, which is where "zoom out comes back to life
  // once you have zoomed in" actually lives — replacing the predicate with a
  // constant passes every rendering assertion and fails these.
  it('offers nothing to undo at fit, and shows the fit glyph rather than 100%', () => {
    expect(zoomControlState(1)).toEqual({
      atFit: true,
      atMax: false,
      label: null,
    });
  });

  it('treats a hair above fit as fit — an animated zoom lands on 1.0000003', () => {
    expect(zoomControlState(1.0000003).atFit).toBe(true);
  });

  it('brings zoom-out and reset back once genuinely zoomed, and reads the scale', () => {
    expect(zoomControlState(2.5)).toEqual({
      atFit: false,
      atMax: false,
      label: '250%',
    });
  });

  it('rounds the reading rather than printing a float at the user', () => {
    expect(zoomControlState(1.337).label).toBe('134%');
  });

  it('stops offering zoom-in at the ceiling', () => {
    expect(zoomControlState(8).atMax).toBe(true);
    expect(zoomControlState(7.9).atMax).toBe(false);
  });

  it('keeps the fit epsilon tight enough to be float slop, not a range', () => {
    // Bounds it from ABOVE. The rows above jump from a hair over 1 straight to
    // 2.5, so widening the epsilon to, say, 0.5 — which would disable zoom-out
    // on a genuinely zoomed 1.4× picture — passes every one of them.
    expect(zoomControlState(1.05).atFit).toBe(false);
  });
});

describe('an image the user can open', () => {
  it('shows only the thumbnail until it is pressed', () => {
    render(<ZoomableImage src={SRC} alt="a shot" />);

    expect(thumbnail()).not.toBeNull();
    expect(viewer()).toBeNull();
  });

  it('opens the same bytes at full size when pressed', () => {
    render(<ZoomableImage src={SRC} alt="a shot" />);

    press(thumbnail()!);

    // The SAME source, not a second fetch: the thumbnail already holds the
    // decoded bytes, and re-reading them would make opening a picture cost a
    // daemon round trip the app has already paid for.
    expect(viewer()?.getAttribute('src')).toBe(SRC);
  });

  it('shows the WHOLE picture, where the thumbnail showed a crop', () => {
    // This is the defect, not a detail of it: the transcript's thumbnails are
    // `object-cover` squares, so a pasted screenshot is cropped to its middle
    // and the app holds no other copy of it. A viewer that also cropped would
    // fix nothing.
    render(
      <ZoomableImage
        src={SRC}
        alt="a shot"
        imgClassName="size-full object-cover"
      />,
    );

    press(thumbnail()!);

    expect(viewer()?.className).toContain('object-contain');
    expect(viewer()?.className).not.toContain('object-cover');
  });

  it('is a BUTTON, so a keyboard can reach the picture at all', () => {
    render(<ZoomableImage src={SRC} alt="a shot" />);

    const el = thumbnail()!;
    expect(el.tagName).toBe('BUTTON');
    // `submit` is the default: inside the composer, which is what the staged
    // strip sits in, pressing a thumbnail would send the message.
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('aria-label')).toBe('View a shot');
  });

  it('closes on Escape', () => {
    // Pins the reuse of `Dialog`'s modal contract rather than a bespoke
    // overlay: an image filling the window with no way out but a mouse is the
    // classic lightbox failure.
    render(<ZoomableImage src={SRC} alt="a shot" />);
    press(thumbnail()!);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(viewer()).toBeNull();
  });

  it('opens outside the element it was pressed from', () => {
    // Portalled deliberately. A markdown image is rendered inside the `<p>`
    // the markdown renderer wrapped it in, and `position: fixed` is resolved
    // against the nearest transformed ancestor rather than the viewport — so
    // a dialog left in place can be clipped, offset, or nested in markup no
    // parser would produce.
    render(
      <p>
        <ZoomableImage src={SRC} alt="a shot" />
      </p>,
    );

    press(thumbnail()!);

    expect(viewer()).not.toBeNull();
    expect(container.contains(viewer())).toBe(false);
  });

  it('offers zoom controls once the picture is open', () => {
    // The point of opening a screenshot is reading something small in it, so a
    // viewer that can only show the whole picture at once answers half the
    // question. Pinned by the accessible names, which are also the only handle
    // a keyboard user has on them.
    render(<ZoomableImage src={SRC} alt="a shot" />);

    // Nothing until it is opened — the thumbnail is a button, not a toolbar.
    expect(control('Zoom in')).toBeNull();

    press(thumbnail()!);

    expect(control('Zoom in')).not.toBeNull();
    expect(control('Zoom out')).not.toBeNull();
    expect(control('Reset zoom to fit')).not.toBeNull();
  });

  it('opens at fit, with nothing to zoom out of or reset', () => {
    // The `atFit` branch, entered deliberately per `.claude/rules/testing.md`.
    // MIN_SCALE IS fit-to-window, so at rest both of these would do nothing —
    // and a live control that does nothing when pressed reads as broken.
    render(<ZoomableImage src={SRC} alt="a shot" />);
    press(thumbnail()!);

    expect(control('Zoom out')!.disabled).toBe(true);
    expect(control('Reset zoom to fit')!.disabled).toBe(true);
    // Zooming IN is the one thing there is always room for.
    expect(control('Zoom in')!.disabled).toBe(false);
  });

  it('draws NO arrows for a lone picture, and ignores the arrow keys', () => {
    // Three of the four surfaces open exactly one image — a markdown image, a
    // pasted attachment, the composer's staged strip. `browsing` defaulting
    // true would put two dead arrows over every one of them, and nothing else
    // in the suite opens the viewer WITHOUT navigation.
    render(<ZoomableImage src={SRC} alt="a shot" />);
    press(thumbnail()!);

    expect(document.body.querySelector('[aria-label="Next image"]')).toBeNull();
    expect(
      document.body.querySelector('[aria-label="Previous image"]'),
    ).toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });

    // Still the same picture, and still open — the key reached no handler.
    expect(viewer()?.getAttribute('src')).toBe(SRC);
  });

  it('heads the viewer with the caller’s own name for the picture', () => {
    // Not `alt`, and not the source: a resolved image is a `data:` URL by the
    // time it reaches here, so the only caption the component could invent for
    // itself is a base64 string. What names it — a file name, the reference an
    // agent wrote — is known one level up.
    render(<ZoomableImage src={SRC} alt="a shot" title="02-transcript.png" />);

    press(thumbnail()!);

    expect(document.body.textContent).toContain('02-transcript.png');
  });
});
