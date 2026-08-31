import type { Meta, StoryObj } from '@storybook/react-vite';

import { CodeBlock } from './code-block';

const SAMPLE = `function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}`;

const meta = {
  title: 'Primitives/CodeBlock',
  component: CodeBlock,
  args: {
    code: SAMPLE,
    language: 'typescript',
  },
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className="w-96">
      <CodeBlock {...args} />
    </div>
  ),
};

export const WithCaption: Story = {
  args: {
    caption: 'apps/ui/src/renderer/components/ui/utils.ts',
  },
  render: (args) => (
    <div className="w-96">
      <CodeBlock {...args} />
    </div>
  ),
};

export const PlainText: Story = {
  args: {
    code: 'no grammar registered for this — falls back to plain text',
    language: 'made-up-language',
  },
  render: (args) => (
    <div className="w-96">
      <CodeBlock {...args} />
    </div>
  ),
};

export const Overflow: Story = {
  args: {
    code: Array.from(
      { length: 30 },
      (_, i) =>
        `const line${i} = 'a line long enough to need horizontal scroll too';`,
    ).join('\n'),
    language: 'typescript',
  },
  render: (args) => (
    <div className="w-96">
      <CodeBlock {...args} />
    </div>
  ),
};
