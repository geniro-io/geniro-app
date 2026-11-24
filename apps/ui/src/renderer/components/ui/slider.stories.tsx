import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Slider } from './slider';

const meta = {
  title: 'Primitives/Slider',
  component: Slider,
  args: {
    value: 40,
    min: 0,
    max: 100,
    step: 1,
    label: 'Volume',
    onValueChange: () => {},
  },
  decorators: [(story) => <div className="w-72">{story()}</div>],
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => {
    function SliderDemo(): React.JSX.Element {
      const [value, setValue] = useState(args.value);
      return <Slider {...args} value={value} onValueChange={setValue} />;
    }
    return <SliderDemo />;
  },
};

export const Steps: Story = {
  args: { value: 3, min: 1, max: 5, step: 1, label: 'Rating' },
  render: (args) => {
    function StepsDemo(): React.JSX.Element {
      const [value, setValue] = useState(args.value);
      return <Slider {...args} value={value} onValueChange={setValue} />;
    }
    return <StepsDemo />;
  },
};

export const Disabled: Story = {
  args: { value: 60, disabled: true },
};
