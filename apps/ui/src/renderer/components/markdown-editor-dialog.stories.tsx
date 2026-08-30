import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { MarkdownEditorDialog } from './markdown-editor-dialog';

const SAMPLE_ROLE = `You are the release-notes agent.

- Summarize merged PRs since the last tag
- Group by feature area
- Keep each bullet under 20 words`;

const meta = {
  title: 'Components/MarkdownEditorDialog',
  component: MarkdownEditorDialog,
  args: {
    // open/onSave/onCancel are dummy defaults satisfying the required-args
    // type — the render below owns real open state and ignores these.
    open: true,
    title: 'Role / system prompt',
    value: SAMPLE_ROLE,
    placeholder: 'Describe what this agent should do…',
    onSave: () => undefined,
    onCancel: () => undefined,
  },
  // Staged edits: the dialog owns its own draft, and Save/Cancel both close
  // it — so the demo needs real open state rather than a fixed prop.
  render: (args) => {
    const [value, setValue] = useState(args.value);
    const [open, setOpen] = useState(true);
    return (
      <MarkdownEditorDialog
        {...args}
        value={value}
        open={open}
        onSave={(next) => {
          setValue(next);
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    );
  },
} satisfies Meta<typeof MarkdownEditorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Empty: Story = {
  args: { value: '' },
};
