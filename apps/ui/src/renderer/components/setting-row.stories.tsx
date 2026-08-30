import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SettingRow } from './setting-row';
import { Switch } from './ui/switch';

const meta = {
  title: 'Components/SettingRow',
  component: SettingRow,
  args: {
    label: 'Cursor Max Mode',
    hint: "Runs every turn at the model's full 1M context window.",
    // Dummy default satisfying the required-args type — every story below
    // supplies its own `children` through `render`.
    children: null,
  },
  render: (args) => {
    const [checked, setChecked] = useState(true);
    return (
      <div className="w-96 rounded-lg border border-border bg-card">
        <SettingRow {...args}>
          <Switch
            aria-label={args.label}
            checked={checked}
            onCheckedChange={setChecked}
          />
        </SettingRow>
      </div>
    );
  },
} satisfies Meta<typeof SettingRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const NoHint: Story = {
  args: { hint: undefined },
};

export const Compact: Story = {
  args: { width: 'compact' },
  render: (args) => {
    const [checked, setChecked] = useState(true);
    return (
      <div className="@container w-80 rounded-lg border border-border bg-card">
        <SettingRow {...args}>
          <Switch
            aria-label={args.label}
            checked={checked}
            onCheckedChange={setChecked}
          />
        </SettingRow>
      </div>
    );
  },
};

export const CompactStacked: Story = {
  args: { width: 'compact' },
  render: (args) => {
    const [checked, setChecked] = useState(true);
    return (
      <div className="@container w-56 rounded-lg border border-border bg-card">
        <SettingRow {...args}>
          <Switch
            aria-label={args.label}
            checked={checked}
            onCheckedChange={setChecked}
          />
        </SettingRow>
      </div>
    );
  },
};
