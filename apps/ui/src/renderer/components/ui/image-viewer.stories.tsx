import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ImageViewer, ZoomableImage } from './image-viewer';

/** A neutral placeholder — an inline SVG, so the story needs no network fetch. */
const PLACEHOLDER_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">' +
      '<rect width="100%" height="100%" fill="lightgray"/>' +
      '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ' +
      'font-family="sans-serif" font-size="24" fill="dimgray">screenshot.png</text>' +
      '</svg>',
  );

/**
 * A LONG screenshot — the shape the viewer is hardest on.
 *
 * Numbered bands, so a reader can tell at a glance which part of it is on
 * screen: if the fit is right, band 1 and band 20 are both visible.
 */
const TALL_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="4000">' +
      '<rect width="100%" height="100%" fill="white"/>' +
      Array.from({ length: 20 }, (_, i) => {
        const y = i * 200;
        // Named CSS colours, like the placeholder above: this is a fixture
        // IMAGE's own payload rather than app styling, and the renderer's
        // no-hex rule cannot tell the two apart.
        const fill = i % 2 === 0 ? 'gainsboro' : 'whitesmoke';
        return (
          `<rect y="${y}" width="100%" height="200" fill="${fill}"/>` +
          `<text x="300" y="${y + 110}" text-anchor="middle" ` +
          `font-family="sans-serif" font-size="64" fill="dimgray">${i + 1}</text>`
        );
      }).join('') +
      '</svg>',
  );

const meta = {
  title: 'Primitives/ImageViewer',
  component: ZoomableImage,
  // The opened viewer is a modal and fills the box the docs preview gives it,
  // which is sized by its content — see the note in `renderer-components.md`.
  decorators: [(story) => <div className="h-[420px]">{story()}</div>],
  args: { src: PLACEHOLDER_SRC },
} satisfies Meta<typeof ZoomableImage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The everyday usage — a thumbnail that opens the full viewer on press. */
export const Playground: Story = {
  render: () => (
    <ZoomableImage
      src={PLACEHOLDER_SRC}
      alt="A pasted screenshot"
      title="screenshot.png"
      className="size-32 overflow-hidden rounded-md border border-border"
      imgClassName="size-full object-cover"
    />
  ),
};

/** The viewer itself, always open — the modal a thumbnail press opens. */
export const Open: Story = {
  render: () => {
    function OpenViewerDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <ImageViewer
          open={open}
          onClose={() => setOpen(false)}
          src={PLACEHOLDER_SRC}
          alt="A pasted screenshot"
          title="screenshot.png"
        />
      );
    }
    return <OpenViewerDemo />;
  },
};

/**
 * A 600×4000 screenshot — the case REPORTED as "I see only its middle part and
 * can't move it": a picture far taller than the window has to be fitted to the
 * window, not cropped by it, and whatever is off screen has to be reachable.
 *
 * Both ends readable at rest is the check: band 1 and band 20 on screen at once.
 */
export const TallScreenshot: Story = {
  render: () => {
    function TallViewerDemo(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <ImageViewer
          open={open}
          onClose={() => setOpen(false)}
          src={TALL_SRC}
          alt="A very tall screenshot"
          title="long-page.png"
        />
      );
    }
    return <TallViewerDemo />;
  },
};
