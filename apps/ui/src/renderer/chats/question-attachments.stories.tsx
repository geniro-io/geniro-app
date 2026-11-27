import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  STUB_PICTURE_DATA_URL,
  stubThreadContextReader,
} from '../__fixtures__/thread-context-reader';
import type { PublishedArtifact } from './published-artifact';
import { QuestionAttachments } from './question-attachments';
import type { QuestionAttachmentSet } from './question-attachments-payload';
import { ThreadContextReaderContext } from './thread-question-context';

const PAGE: PublishedArtifact = {
  artifactId: 'pr-673-acceptance',
  version: 2,
  title: 'PR #673 — acceptance',
  summary: 'The acceptance run, with the strip and the chart.',
  key: 'k'.repeat(64),
};

const PAGE_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><body style="margin:0;padding:8px;font:14px system-ui;color:#222">The acceptance page the thread published.</body>',
)}`;

const ATTACHED: QuestionAttachmentSet = {
  attachments: [
    {
      kind: 'artifact',
      artifactId: PAGE.artifactId,
      title: PAGE.title,
      version: PAGE.version,
    },
    {
      kind: 'gallery',
      seq: 12,
      gallery: {
        title: 'Strip screenshots',
        images: [
          {
            path: 'shots/strip.png',
            caption: 'The strip',
            description: null,
            source: null,
          },
          {
            path: 'shots/chart.png',
            caption: null,
            description: null,
            source: null,
          },
        ],
      },
    },
  ],
  moreAttachments: 2,
};

function withPages(pages: PublishedArtifact[]) {
  return (story: () => React.JSX.Element): React.JSX.Element => (
    <ThreadContextReaderContext.Provider
      value={stubThreadContextReader(() => Promise.resolve([]), {
        artifactUrl: () => () => PAGE_HTML,
        loadImage: () => () => Promise.resolve(STUB_PICTURE_DATA_URL),
        artifacts: () => Promise.resolve(pages),
      })}>
      {story()}
    </ThreadContextReaderContext.Provider>
  );
}

const meta = {
  title: 'Chats/QuestionAttachments',
  component: QuestionAttachments,
  args: { threadRunId: 'thread-1', set: ATTACHED, variant: 'preview' },
  decorators: [
    (story) => <div className="w-[400px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof QuestionAttachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = {
  decorators: [withPages([PAGE])],
};

export const PreviewPageGone: Story = {
  decorators: [withPages([])],
};

export const Chips: Story = {
  args: { variant: 'chips' },
  decorators: [withPages([PAGE])],
};

export const ChipsPageGone: Story = {
  args: {
    variant: 'chips',
    set: { attachments: [ATTACHED.attachments[0]!], moreAttachments: 0 },
  },
  decorators: [withPages([])],
};
