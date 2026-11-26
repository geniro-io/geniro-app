import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  STUB_PICTURE_DATA_URL,
  stubThreadContextReader,
} from '../__fixtures__/thread-context-reader';
import { QuestionContextMessages } from './question-context-messages';
import {
  type ThreadContextEntry,
  type ThreadContextMessage,
  type ThreadContextReader,
  ThreadContextReaderContext,
} from './thread-question-context';

const MESSAGES: ThreadContextMessage[] = [
  { seq: 4, role: 'user', text: 'Clear the cache, the shared one' },
  {
    seq: 5,
    role: 'assistant',
    text: 'Two caches could be meant: the shared Redis and the copy on this machine.',
  },
  { seq: 6, role: 'user', text: 'The shared one' },
];

const WITH_PAGE_AND_PICTURES: ThreadContextEntry[] = [
  { seq: 4, role: 'user', text: 'Take the acceptance screenshots' },
  {
    seq: 5,
    artifact: {
      artifactId: 'pr-673-acceptance',
      version: 1,
      title: 'PR #673 — acceptance',
      summary: null,
      key: 'k'.repeat(64),
    },
  },
  {
    seq: 6,
    gallery: {
      title: 'Strip screenshots',
      images: [
        {
          path: 'shots/strip.png',
          caption: 'The strip',
          description: null,
          source: null,
        },
      ],
    },
  },
];

const PAGE_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><body style="margin:0;padding:8px;font:14px system-ui;color:#222">The acceptance page the thread published.</body>',
)}`;

function withRead(
  read: ThreadContextReader['read'],
  options?: Parameters<typeof stubThreadContextReader>[1],
) {
  return (story: () => React.JSX.Element): React.JSX.Element => (
    <ThreadContextReaderContext.Provider
      value={stubThreadContextReader(read, options)}>
      {story()}
    </ThreadContextReaderContext.Provider>
  );
}

const LONG_MESSAGES: ThreadContextMessage[] = [
  {
    seq: 4,
    role: 'user',
    text: 'Clear the shared cache, the one the staging stand reads.\nIt was filled from the nightly import, so the numbers on the dashboard may lag.\nKeep the local copy as it is.\nThe session tokens live in the shared one too, so signed-in users will be signed out.\nCheck with the stand owner first.',
  },
  {
    seq: 5,
    role: 'assistant',
    text: 'Two caches could be meant: the shared Redis and the copy on this machine.\nThe shared Redis holds the session tokens for every signed-in user.\nThe local copy only holds the last build’s compiled assets.\nClearing the shared one signs everyone out for about a minute while it refills.\nClearing the local one costs nothing but a slower first load.',
  },
  {
    seq: 6,
    role: 'user',
    text: 'The shared one, then. I will warn the stand owner first.\nDo it after the import finishes.\nTell me when it is done.\nAnd leave the local copy alone.\nThanks.',
  },
];

const meta = {
  title: 'Chats/QuestionContextMessages',
  component: QuestionContextMessages,
  args: { threadRunId: 'thread-1', threadRequestId: 'req-1' },
  decorators: [
    (story) => <div className="w-[400px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof QuestionContextMessages>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
  decorators: [withRead(() => Promise.resolve(MESSAGES))],
};

export const WithPageAndPictures: Story = {
  decorators: [
    withRead(() => Promise.resolve(WITH_PAGE_AND_PICTURES), {
      artifactUrl: () => () => PAGE_HTML,
      loadImage: () => () => Promise.resolve(STUB_PICTURE_DATA_URL),
    }),
  ],
};

export const LongMessages: Story = {
  decorators: [withRead(() => Promise.resolve(LONG_MESSAGES))],
};

export const LongMessagesWithPage: Story = {
  decorators: [
    withRead(
      () =>
        Promise.resolve([
          ...LONG_MESSAGES,
          ...WITH_PAGE_AND_PICTURES.filter((entry) => !('role' in entry)),
        ]),
      {
        artifactUrl: () => () => PAGE_HTML,
        loadImage: () => () => Promise.resolve(STUB_PICTURE_DATA_URL),
      },
    ),
  ],
};

export const NothingBeforeQuestion: Story = {
  decorators: [withRead(() => Promise.resolve([]))],
};

export const Unreadable: Story = {
  decorators: [withRead(() => Promise.reject(new Error('daemon down')))],
};
