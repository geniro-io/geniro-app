import type { Meta, StoryObj } from '@storybook/react-vite';

import { WAIT_META, WaitMark } from './wait-mark';
import type { WaitState } from './waiting';

const STATES = Object.keys(WAIT_META) as WaitState[];

const meta = {
  title: 'Chats/WaitMark',
  component: WaitMark,
  args: { state: 'asking' },
} satisfies Meta<typeof WaitMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Asking: Story = {};

/** Every wait, most urgent first, with the word its hover carries. */
export const AllStates: Story = {
  render: () => (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs">
      {STATES.map((state) => (
        <li key={state} className="flex items-center gap-2">
          <WaitMark state={state} />
          {WAIT_META[state].label}
        </li>
      ))}
    </ul>
  ),
};
