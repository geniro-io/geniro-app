import type { Meta, StoryObj } from '@storybook/react-vite';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Select, type SelectGroup } from './select';

const AGENT_GROUPS: SelectGroup[] = [
  {
    label: 'Agents',
    items: [
      { value: 'claude', label: 'Claude' },
      { value: 'cursor', label: 'Cursor', hint: 'ACP' },
    ],
  },
  {
    label: 'Workflows',
    items: [{ value: 'wf:dev-team', label: 'Dev team' }],
  },
];

const meta = {
  title: 'Primitives/Select',
  component: Select,
  args: { groups: AGENT_GROUPS, value: 'claude', onValueChange: () => {} },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => {
    function SelectDemo(): React.JSX.Element {
      const [value, setValue] = useState<string | null>('claude');
      return (
        <Select
          groups={AGENT_GROUPS}
          value={value}
          onValueChange={setValue}
          className="w-56"
        />
      );
    }
    return <SelectDemo />;
  },
};

export const Ghost: Story = {
  render: () => {
    function SelectDemo(): React.JSX.Element {
      const [value, setValue] = useState<string | null>('claude');
      return (
        <Select
          groups={AGENT_GROUPS}
          value={value}
          onValueChange={setValue}
          variant="ghost"
          leadingIcon={<FolderOpen />}
        />
      );
    }
    return <SelectDemo />;
  },
};

export const Searchable: Story = {
  render: () => {
    function SelectDemo(): React.JSX.Element {
      const [value, setValue] = useState<string | null>(null);
      return (
        <Select
          groups={AGENT_GROUPS}
          value={value}
          onValueChange={setValue}
          placeholder="Choose an agent…"
          searchPlaceholder="Search agents…"
          className="w-56"
        />
      );
    }
    return <SelectDemo />;
  },
};

export const Disabled: Story = {
  render: () => (
    <Select
      groups={AGENT_GROUPS}
      value="claude"
      onValueChange={() => {}}
      disabled
      className="w-56"
    />
  ),
};
