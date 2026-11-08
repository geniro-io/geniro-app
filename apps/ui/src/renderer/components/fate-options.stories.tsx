import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { FateOptions } from './fate-options';

const FATES = [
  { fate: 'keep', label: 'Keep them', detail: 'Nothing moves.' },
  { fate: 'drop', label: 'Delete them', detail: 'This cannot be undone.' },
] as const;

function Stateful(): React.JSX.Element {
  const [value, setValue] = useState<'keep' | 'drop'>('keep');
  return (
    <FateOptions
      label="Documents"
      fates={FATES}
      value={value}
      onChange={setValue}
    />
  );
}

const meta: Meta<typeof Stateful> = {
  title: 'Components/FateOptions',
  component: Stateful,
};

export default meta;

export const Default: StoryObj<typeof Stateful> = {};
