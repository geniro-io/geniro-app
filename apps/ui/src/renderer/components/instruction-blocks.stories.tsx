import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { InheritedTag } from './inherited-tag';
import {
  InstructionBlockCard,
  InstructionBlockList,
  ReadOnlyInstructionBlockCard,
} from './instruction-blocks';

interface Block {
  id: string;
  title: string;
  text: string;
}

const BLOCKS: Block[] = [
  { id: 'build', title: 'Build', text: 'Use pnpm only. Run pnpm full-check.' },
  {
    id: 'style',
    title: 'Code style',
    text: 'No comments that restate the code. Style from tokens only.',
  },
];

function Stateful({ initial }: { initial: Block[] }): React.JSX.Element {
  const [blocks, setBlocks] = useState(initial);
  const patch = (id: string, next: Partial<Block>): void =>
    setBlocks((current) =>
      current.map((block) => (block.id === id ? { ...block, ...next } : block)),
    );
  return (
    <div className="w-[640px]">
      <InstructionBlockList
        empty={blocks.length === 0}
        emptyLabel="No instructions yet."
        onAdd={() =>
          setBlocks((current) => [
            ...current,
            { id: `block-${current.length + 1}`, title: '', text: '' },
          ])
        }>
        {blocks.map((block) => (
          <InstructionBlockCard
            key={block.id}
            id={block.id}
            title={block.title}
            text={block.text}
            size={{
              chars: block.text.length,
              approxTokens: block.text.length / 4,
            }}
            sizeTitle={`${block.text.length} characters`}
            onTitleChange={(title) => patch(block.id, { title })}
            onTextChange={(text) => patch(block.id, { text })}
            onRemove={() =>
              setBlocks((current) =>
                current.filter((entry) => entry.id !== block.id),
              )
            }
          />
        ))}
      </InstructionBlockList>
    </div>
  );
}

const meta = {
  title: 'Components/InstructionBlocks',
  component: Stateful,
} satisfies Meta<typeof Stateful>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Blocks: Story = { args: { initial: BLOCKS } };

export const Empty: Story = { args: { initial: [] } };

export const WithIssues: Story = {
  args: { initial: [] },
  render: () => (
    <ul className="w-[640px]">
      <InstructionBlockCard
        id="bad"
        title={'A title far too long '.repeat(5)}
        text="Pasted text"
        issues={[
          {
            field: 'title',
            message: 'A title may have at most 80 characters.',
          },
          {
            field: 'text',
            message: 'Contains invisible control characters.',
          },
        ]}
        onTitleChange={() => undefined}
        onTextChange={() => undefined}
        onRemove={() => undefined}
      />
    </ul>
  ),
};

export const ReadOnly: Story = {
  args: { initial: [] },
  render: () => (
    <div className="w-[640px]">
      <InstructionBlockList empty={false} emptyLabel="No instructions yet.">
        {BLOCKS.map((block) => (
          <ReadOnlyInstructionBlockCard
            key={block.id}
            id={block.id}
            title={block.title}
            text={block.text}
            tag={<InheritedTag variant="team" />}
          />
        ))}
      </InstructionBlockList>
    </div>
  ),
};
