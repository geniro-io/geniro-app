import type { Meta, StoryObj } from '@storybook/react-vite';

import { boardCard } from '../__fixtures__/board-cards';
import { questionRequest } from '../__fixtures__/open-requests';
import { stubThreadContextReader } from '../__fixtures__/thread-context-reader';
import {
  ThreadDoneDismissalsContext,
  ThreadFinishKeysContext,
} from '../chats/thread-done-context';
import { ThreadContextReaderContext } from '../chats/thread-question-context';
import { ThreadOpenContext } from '../chats/thread-title';
import { AttentionCardBody } from './attention-card';

const READER = stubThreadContextReader(() => Promise.resolve([]), {
  artifacts: () =>
    Promise.resolve([
      {
        artifactId: 'report',
        version: 1,
        title: 'Release notes',
        summary: null,
        key: 'k',
      },
    ]),
});

const meta = {
  title: 'Command center/AttentionCardBody',
  component: AttentionCardBody,
  args: {
    card: {
      key: 'request:q:q-1',
      at: null,
      kind: 'question',
      request: questionRequest('q', 'q-1', { title: 'Fix the login redirect' }),
    },
    onAnswer: () => undefined,
  },
  decorators: [
    (story) => (
      <ThreadContextReaderContext.Provider value={READER}>
        <ThreadDoneDismissalsContext.Provider
          value={{
            through: new Map(),
            finishes: new Map(),
            dismiss: () => undefined,
          }}>
          <ThreadFinishKeysContext.Provider value={new Map([['t1', 'fk-t1']])}>
            <ThreadOpenContext.Provider value={() => undefined}>
              <div className="w-[560px] bg-background p-4">{story()}</div>
            </ThreadOpenContext.Provider>
          </ThreadFinishKeysContext.Provider>
        </ThreadDoneDismissalsContext.Provider>
      </ThreadContextReaderContext.Provider>
    ),
  ],
} satisfies Meta<typeof AttentionCardBody>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A thread's question with its Go to thread button. */
export const Question: Story = {};

/** A finished thread: its report, its pages, Open chat, Dismiss and Archive. */
export const Finished: Story = {
  args: {
    card: {
      key: 'finished:t1',
      at: null,
      kind: 'finished',
      card: boardCard('t1', { column: 'done', title: 'Ship the release' }),
    },
  },
};

/** A failed thread: Open chat and Archive, no Dismiss. */
export const Failed: Story = {
  args: {
    card: {
      key: 'failed:t2',
      at: null,
      kind: 'failed',
      card: boardCard('t2', { status: 'failed', title: 'Migrate the cache' }),
    },
  },
};
