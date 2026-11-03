import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  AssessmentVerdict,
  type AssessmentVerdictValue,
} from './assessment-verdict';

function Stateful({
  initial,
}: {
  initial: AssessmentVerdictValue | null;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-[420px]">
      <AssessmentVerdict
        value={value}
        onChange={async (next) => setValue(next)}
      />
    </div>
  );
}

const meta = {
  title: 'Components/AssessmentVerdict',
  component: AssessmentVerdict,
  args: { value: null },
} satisfies Meta<typeof AssessmentVerdict>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotGiven: Story = { render: () => <Stateful initial={null} /> };

export const Disagreed: Story = {
  render: () => (
    <Stateful
      initial={{
        verdict: 'disagree',
        note: 'It missed the race in divide — quality is not a 5.',
      }}
    />
  ),
};

export const ReadOnly: Story = {
  args: { value: { verdict: 'agree', note: null } },
};
