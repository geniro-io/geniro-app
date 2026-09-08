import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Stepper } from './stepper';

/**
 * A small whole number changed by pressing − and +, in place of the native
 * number field's OS spinner. Every story drives it from real state, so the
 * bound behaviour (an end button disabling itself) is visible rather than
 * described.
 */
const meta = {
  title: 'Primitives/Stepper',
  component: Stepper,
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

function Live({
  start,
  min,
  max,
  disabled,
}: {
  start: number;
  min: number;
  max: number;
  disabled?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState(start);
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      Runs at once
      <Stepper
        value={value}
        min={min}
        max={max}
        disabled={disabled ?? false}
        aria-label="Runs at once"
        onChange={setValue}
      />
    </div>
  );
}

export const Default: Story = {
  args: {
    value: 3,
    min: 1,
    max: 5,
    'aria-label': 'Runs at once',
    onChange: () => {},
  },
  render: () => <Live start={3} min={1} max={5} />,
};

/** At the floor the − is disabled: there is nowhere further to go. */
export const AtMinimum: Story = {
  args: {
    value: 1,
    min: 1,
    max: 5,
    'aria-label': 'Runs at once',
    onChange: () => {},
  },
  render: () => <Live start={1} min={1} max={5} />,
};

/** And at the ceiling, the +. */
export const AtMaximum: Story = {
  args: {
    value: 5,
    min: 1,
    max: 5,
    'aria-label': 'Runs at once',
    onChange: () => {},
  },
  render: () => <Live start={5} min={1} max={5} />,
};

export const Disabled: Story = {
  args: {
    value: 3,
    min: 1,
    max: 5,
    disabled: true,
    'aria-label': 'Runs at once',
    onChange: () => {},
  },
  render: () => <Live start={3} min={1} max={5} disabled />,
};
