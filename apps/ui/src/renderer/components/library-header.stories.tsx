import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';

import { LibraryHeader } from './library-header';
import { Button } from './ui/button';

const meta = {
  title: 'Components/LibraryHeader',
  component: LibraryHeader,
  args: {
    title: 'Projects',
    count: 3,
    subtitle: 'One folder, one board, one set of standing instructions.',
    actions: (
      <Button type="button" className="h-8 gap-2 rounded-control">
        <Plus aria-hidden="true" /> New project
      </Button>
    ),
  },
  decorators: [(story) => <div className="w-[720px]">{story()}</div>],
} satisfies Meta<typeof LibraryHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithCount: Story = {};

/** Before the first read lands, the count is not drawn. */
export const Loading: Story = { args: { count: null } };
