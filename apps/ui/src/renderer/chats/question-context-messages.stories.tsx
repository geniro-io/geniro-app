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

export const NothingBeforeQuestion: Story = {
  decorators: [withReader(() => Promise.resolve([]))],
};

export const Unreadable: Story = {
  decorators: [withReader(() => Promise.reject(new Error('daemon down')))],
};
