// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ZoomableImage } from './image-viewer';

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

function press(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

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
