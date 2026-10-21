import type { Meta, StoryObj } from '@storybook/react-vite';

import { MonitorNoticeRow } from './monitor-divider';
import type { MonitorEntry } from './monitor-payload';

function entry(over: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    id: 'm1',
    description: 'dev server log',
    event: 'batch',
    end: null,
    lines: [
      'compiled client in 412ms',
      '\u001b[31merror\u001b[0m TS2322: Type string is not assignable to number',
    ],
    omitted: 0,
    ...over,
  };
}

const meta = {
  title: 'Chats/MonitorNoticeRow',
  component: MonitorNoticeRow,
  args: {
    agent: 'Builder',
    memoryKey: 'story:monitor',
    notice: { woke: true, monitors: [entry()] },
  },
  decorators: [
    (story) => <div className="w-[560px] bg-background p-4">{story()}</div>,
  ],
} satisfies Meta<typeof MonitorNoticeRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Batch: Story = {};

export const BatchWithCutLines: Story = {
  args: {
    notice: { woke: true, monitors: [entry({ omitted: 120 })] },
  },
};

export const CleanExit: Story = {
  args: {
    notice: {
      woke: true,
      monitors: [
        entry({ event: 'end', end: { kind: 'exit', code: 0 }, lines: [] }),
      ],
    },
  },
};

export const BadEnding: Story = {
  args: {
    notice: {
      woke: true,
      monitors: [
        entry({ event: 'end', end: { kind: 'timeout' }, lines: ['tick 41'] }),
      ],
    },
  },
};

export const StoppedQuietly: Story = {
  args: {
    notice: {
      woke: false,
      monitors: [entry({ event: 'end', end: { kind: 'stopped' }, lines: [] })],
    },
  },
};
