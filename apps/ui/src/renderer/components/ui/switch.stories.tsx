import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Switch } from './switch';

const meta = {
  title: 'Primitives/Switch',
  component: Switch,
  args: { checked: true, onCheckedChange: () => {} },
  argTypes: {
    size: { control: 'select', options: ['default', 'sm'] },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => {
    function SwitchDemo(): React.JSX.Element {
      const [checked, setChecked] = useState(true);
      return (
        <Switch {...args} checked={checked} onCheckedChange={setChecked} />
      );
    }
    return <SwitchDemo />;
  },
};

export const Sizes: Story = {
  render: () => {
    function SwitchDemo(): React.JSX.Element {
      const [checked, setChecked] = useState(true);
      return (
        <div className="flex items-center gap-4">
          <Switch
            checked={checked}
            onCheckedChange={setChecked}
            size="default"
          />
          <Switch checked={checked} onCheckedChange={setChecked} size="sm" />
        </div>
      );
    }
    return <SwitchDemo />;
  },
};

export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Switch checked={false} onCheckedChange={() => {}} disabled />
      <Switch checked={true} onCheckedChange={() => {}} disabled />
    </div>
  ),
};
