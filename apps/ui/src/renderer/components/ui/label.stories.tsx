import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './input';
import { Label } from './label';

const meta = {
  title: 'Primitives/Label',
  component: Label,
  args: { children: 'Folder' },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithField: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="folder-input">Folder</Label>
      <Input
        id="folder-input"
        defaultValue="~/Desktop/Projects/Geniro/geniro-app"
      />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="group flex flex-col gap-1.5" data-disabled="true">
      <Label htmlFor="folder-input-disabled">Folder</Label>
      <Input id="folder-input-disabled" disabled defaultValue="Locked" />
    </div>
  ),
};
