import type { Meta, StoryObj } from '@storybook/react-vite';

import { TimelineStrip } from './timeline-strip';

const RANGE = {
  start: '2026-11-17T06:00:00.000Z',
  end: '2026-11-17T14:00:00.000Z',
};

const meta = {
  title: 'Components/TimelineStrip',
  component: TimelineStrip,
  args: {
    ...RANGE,
    spans: [
      {
        kind: 'work',
        start: '2026-11-17T06:30:00.000Z',
        end: '2026-11-17T08:10:00.000Z',
      },
      {
        kind: 'waiting',
        start: '2026-11-17T08:10:00.000Z',
        end: '2026-11-17T09:00:00.000Z',
      },
      { kind: 'work', start: '2026-11-17T09:00:00.000Z', end: null },
    ],
    markers: [
      {
        kind: 'user_message',
        at: '2026-11-17T06:20:00.000Z',
        label: 'Fix the login redirect',
      },
      { kind: 'stage', at: '2026-11-17T07:40:00.000Z', label: 'Build' },
      {
        kind: 'question',
        at: '2026-11-17T08:10:00.000Z',
        label: 'Which branch?',
      },
      { kind: 'pr_opened', at: '2026-11-17T09:30:00.000Z', label: 'PR 412' },
      { kind: 'failure', at: '2026-11-17T10:05:00.000Z', label: 'Test run' },
      {
        kind: 'manager_out',
        at: '2026-11-17T11:15:00.000Z',
        label: 'Ask for a status',
      },
      { kind: 'manager_in', at: '2026-11-17T11:40:00.000Z', label: null },
      { kind: 'pr_merged', at: '2026-11-17T12:50:00.000Z', label: 'PR 412' },
    ],
    onMarker: () => {},
  },
  decorators: [
    (story) => <div className="w-full max-w-[360px] p-4">{story()}</div>,
  ],
} satisfies Meta<typeof TimelineStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {};

export const Empty: Story = {
  args: { spans: [], markers: [] },
};

export const OpenWork: Story = {
  args: {
    spans: [{ kind: 'work', start: '2026-11-17T12:00:00.000Z', end: null }],
    markers: [
      { kind: 'user_message', at: '2026-11-17T12:05:00.000Z', label: null },
    ],
  },
};

export const OutOfRange: Story = {
  args: {
    spans: [
      {
        kind: 'waiting',
        start: '2026-11-17T04:00:00.000Z',
        end: '2026-11-17T07:00:00.000Z',
      },
    ],
    markers: [
      {
        kind: 'failure',
        at: '2026-11-17T15:30:00.000Z',
        label: 'After the window',
      },
    ],
  },
};
