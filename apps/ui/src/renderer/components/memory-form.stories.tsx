import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { MEMORY_PROJECTS } from '../__fixtures__/memories';
import { MemoryForm, type MemoryFormValue } from './memory-form';

const EMPTY: MemoryFormValue = {
  title: '',
  body: '',
  type: 'feedback',
  projectId: null,
};

function Demo({
  initial,
  saving = false,
  error = null,
}: {
  initial: MemoryFormValue;
  saving?: boolean;
  error?: string | null;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-[480px]">
      <MemoryForm
        value={value}
        projects={MEMORY_PROJECTS}
        saving={saving}
        error={error}
        submitLabel="Save note"
        onChange={setValue}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: 'Components/MemoryForm',
  component: Demo,
  args: { initial: EMPTY },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Filled: Story = {
  args: {
    initial: {
      title: 'A sent invoice is never edited',
      body: 'Issue a credit note instead of editing a sent invoice.',
      type: 'project',
      projectId: 'project-billing',
    },
  },
};

export const BodyOverTheLimit: Story = {
  args: {
    initial: {
      title: 'Too much to remember',
      body: 'x'.repeat(8300),
      type: 'reference',
      projectId: null,
    },
  },
};

export const Saving: Story = {
  args: {
    saving: true,
    initial: { ...EMPTY, title: 'Saving', body: 'One moment' },
  },
};

export const Refused: Story = {
  args: {
    error: 'A note with this title already exists in this scope',
    initial: { ...EMPTY, title: 'Duplicate', body: 'Same again' },
  },
};
