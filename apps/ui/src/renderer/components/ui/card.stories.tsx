import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';

const meta = {
  title: 'Primitives/Card',
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Run configuration</CardTitle>
        <CardDescription>Started from the sidebar’s + button.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-foreground">
          Points a new chat at a folder, branch, agent and model in one press.
        </p>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button size="sm">Apply</Button>
      </CardFooter>
    </Card>
  ),
};

export const Simple: Story = {
  render: () => (
    <Card className="w-72">
      <CardContent className="pt-5">
        <p className="text-sm text-foreground">
          A bare card with content alone — no header or footer.
        </p>
      </CardContent>
    </Card>
  ),
};
