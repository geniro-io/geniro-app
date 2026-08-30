import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { OptionList } from './option-list';

const OPTIONS = ['SQLite', 'Postgres', 'A local file, no database at all'];

const meta = {
  title: 'Primitives/OptionList',
  component: OptionList,
  args: { options: OPTIONS, selected: [], arity: 'one', onPick: () => {} },
} satisfies Meta<typeof OptionList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => {
    function OptionListDemo(): React.JSX.Element {
      const [selected, setSelected] = useState<string[]>(['SQLite']);
      return (
        <OptionList
          options={OPTIONS}
          selected={selected}
          arity="one"
          label="Storage engine"
          onPick={(option) => setSelected([option])}
        />
      );
    }
    return <OptionListDemo />;
  },
};

export const PickMany: Story = {
  render: () => {
    function OptionListDemo(): React.JSX.Element {
      const [selected, setSelected] = useState<string[]>(['SQLite']);
      return (
        <OptionList
          options={OPTIONS}
          selected={selected}
          arity="many"
          label="Storage engines to consider"
          onPick={(option) =>
            setSelected((current) =>
              current.includes(option)
                ? current.filter((item) => item !== option)
                : [...current, option],
            )
          }
        />
      );
    }
    return <OptionListDemo />;
  },
};

export const AnswerOnClick: Story = {
  render: () => (
    <OptionList
      options={['Yes, proceed', 'No, stop here']}
      selected={[]}
      arity="none"
      label="Proceed with the migration?"
      onPick={() => {}}
    />
  ),
};

export const Disabled: Story = {
  render: () => (
    <OptionList
      options={OPTIONS}
      selected={['SQLite']}
      arity="one"
      disabled
      label="Storage engine (already answered)"
      onPick={() => {}}
    />
  ),
};
