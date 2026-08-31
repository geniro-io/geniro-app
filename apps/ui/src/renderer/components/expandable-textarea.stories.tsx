import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ExpandableTextarea } from './expandable-textarea';

function ExpandableTextareaDemo({
  initialValue = '',
  title = 'Role / system prompt',
  rows,
  maxRows,
  placeholder,
}: {
  initialValue?: string;
  title?: string;
  rows?: number;
  maxRows?: number;
  placeholder?: string;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="w-96">
      <ExpandableTextarea
        value={value}
        onChange={setValue}
        title={title}
        rows={rows}
        maxRows={maxRows}
        placeholder={placeholder}
      />
    </div>
  );
}

const meta = {
  title: 'Components/ExpandableTextarea',
  component: ExpandableTextareaDemo,
} satisfies Meta<typeof ExpandableTextareaDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  args: {
    placeholder: 'Describe how this agent should behave…',
  },
};

export const WithValue: Story = {
  args: {
    initialValue:
      'Review the diff and report findings — never edit code directly.',
  },
};

export const GrowsAndScrolls: Story = {
  args: {
    rows: 3,
    maxRows: 6,
    initialValue: Array.from(
      { length: 10 },
      (_, i) =>
        `Line ${i + 1} of a role prompt long enough to hit the field's cap.`,
    ).join('\n'),
  },
};
