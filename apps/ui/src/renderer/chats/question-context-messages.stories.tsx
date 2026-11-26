import type { Meta, StoryObj } from '@storybook/react-vite';

import { QuestionContextMessages } from './question-context-messages';
import {
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

function withReader(reader: ThreadContextReader) {
  return (story: () => React.JSX.Element): React.JSX.Element => (
    <ThreadContextReaderContext.Provider value={reader}>
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
  decorators: [withReader(() => Promise.resolve(MESSAGES))],
};

export const LongMessages: Story = {
  decorators: [withReader(() => Promise.resolve(LONG_MESSAGES))],
};

export const NothingBeforeQuestion: Story = {
  decorators: [withReader(() => Promise.resolve([]))],
};

export const Unreadable: Story = {
  decorators: [withReader(() => Promise.reject(new Error('daemon down')))],
};
