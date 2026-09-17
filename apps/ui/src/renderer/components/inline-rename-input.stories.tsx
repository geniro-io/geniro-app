import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { InlineRenameInput } from './inline-rename-input';

const meta = {
  title: 'Components/InlineRenameInput',
  component: InlineRenameInput,
  args: {
    value: 'dev server',
    ariaLabel: 'Rename tab',
    onCommit: () => undefined,
    onCancel: () => undefined,
  },
} satisfies Meta<typeof InlineRenameInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** The whole round trip: double-click the name, type, Enter or Escape. */
export const InARow: Story = {
  render: () => {
    function Row(): React.JSX.Element {
      const [name, setName] = useState('dev server');
      const [editing, setEditing] = useState(true);
      return (
        <div className="flex w-64 items-center gap-2">
          {editing ? (
            <InlineRenameInput
              value={name}
              ariaLabel="Rename tab"
              maxLength={60}
              onCommit={(next) => {
                setName(next.trim());
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <button
              type="button"
              className="text-sm"
              onDoubleClick={() => setEditing(true)}>
              {name}
            </button>
          )}
        </div>
      );
    }
    return <Row />;
  },
};
