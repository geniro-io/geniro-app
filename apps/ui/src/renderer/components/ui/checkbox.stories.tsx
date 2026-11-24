import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Checkbox, CheckIndicator } from './checkbox';

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  args: {
    checked: true,
    onCheckedChange: () => {},
    label: 'Send a weekly summary',
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => {
    function CheckboxDemo(): React.JSX.Element {
      const [checked, setChecked] = useState(args.checked);
      return (
        <Checkbox {...args} checked={checked} onCheckedChange={setChecked} />
      );
    }
    return <CheckboxDemo />;
  },
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Checkbox checked={false} onCheckedChange={() => {}} label="Unchecked" />
      <Checkbox checked onCheckedChange={() => {}} label="Checked" />
      <Checkbox
        checked={false}
        disabled
        onCheckedChange={() => {}}
        label="Disabled, unchecked"
      />
      <Checkbox
        checked
        disabled
        onCheckedChange={() => {}}
        label="Disabled, checked"
      />
    </div>
  ),
};

export const Indicators: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-2">
        <CheckIndicator checked={false} shape="square" />
        <CheckIndicator checked shape="square" />
        <span className="text-sm text-muted-foreground">many</span>
      </div>
      <div className="flex items-center gap-2">
        <CheckIndicator checked={false} shape="round" />
        <CheckIndicator checked shape="round" />
        <span className="text-sm text-muted-foreground">one</span>
      </div>
    </div>
  ),
};
