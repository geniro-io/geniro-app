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

const meta = {
  title: 'Primitives/ImageViewer',
  component: ZoomableImage,
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
