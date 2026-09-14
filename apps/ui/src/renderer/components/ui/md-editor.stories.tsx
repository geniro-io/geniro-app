import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { MdEditor } from './md-editor';

const SAMPLE = `# Agent instructions

Every turn carries an instruction block, composed at **one seam**.

- geniro's own host preamble
- the user's custom instructions
- the node's own role
`;

const meta = {
  title: 'Primitives/MdEditor',
  component: MdEditor,
  args: { value: SAMPLE, height: 320 },
} satisfies Meta<typeof MdEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => {
    function MdEditorDemo(): React.JSX.Element {
      const [value, setValue] = useState(args.value);
      return <MdEditor {...args} value={value} onChange={setValue} />;
    }
    return <MdEditorDemo />;
  },
};

export const EditOnly: Story = {
  args: { preview: 'edit' },
  render: (args) => {
    function MdEditorDemo(): React.JSX.Element {
      const [value, setValue] = useState(args.value);
      return <MdEditor {...args} value={value} onChange={setValue} />;
    }
    return <MdEditorDemo />;
  },
};

/**
 * A prompt carrying a `<placeholder>`, which CommonMark reads as an HTML tag.
 * The preview must show it as typed and keep every line after it — it used to
 * open an element that swallowed the rest of the block.
 */
export const AngleBracketPlaceholders: Story = {
  args: {
    value: `TEAM SETTINGS — edit these values. Repo: ManifestOS.

Workspace: a worktree at .claude/worktrees/<linear-id-slug> on a NEW branch cut from main. Pass \`worktree\`.
Worktree env: set a worktree up with the repo's \`manifest-worktree\` skill.
Depth: standard. Never pass --deep.
Ship: draft PR. Pass \`draft only\`.
`,
  },
  render: (args) => {
    function MdEditorDemo(): React.JSX.Element {
      const [value, setValue] = useState(args.value);
      return <MdEditor {...args} value={value} onChange={setValue} />;
    }
    return <MdEditorDemo />;
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
};

export const Empty: Story = {
  args: { value: '', placeholder: 'Write your standing instructions…' },
  render: (args) => {
    function MdEditorDemo(): React.JSX.Element {
      const [value, setValue] = useState(args.value);
      return <MdEditor {...args} value={value} onChange={setValue} />;
    }
    return <MdEditorDemo />;
  },
};
