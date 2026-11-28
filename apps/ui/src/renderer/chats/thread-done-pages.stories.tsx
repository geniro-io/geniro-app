import type { Meta, StoryObj } from '@storybook/react-vite';

import { stubThreadContextReader } from '../__fixtures__/thread-context-reader';
import { ThreadDonePages } from './thread-done-pages';
import { ThreadContextReaderContext } from './thread-question-context';

const page = (artifactId: string, title: string) => ({
  artifactId,
  version: 1,
  title,
  summary: null,
  key: 'k',
});

const meta = {
  title: 'Chats/ThreadDonePages',
  component: ThreadDonePages,
  args: { runId: 'run-1' },
  decorators: [
    (story) => (
      <ThreadContextReaderContext.Provider
        value={stubThreadContextReader(() => Promise.resolve([]), {
          artifacts: () =>
            Promise.resolve([
              page('notes', 'Release notes'),
              page('plan', 'Rollout plan'),
            ]),
        })}>
        <div className="w-[480px] bg-background p-4">{story()}</div>
      </ThreadContextReaderContext.Provider>
    ),
  ],
} satisfies Meta<typeof ThreadDonePages>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The pages a finished thread published, each a chip that opens it. */
export const TwoPages: Story = {};
