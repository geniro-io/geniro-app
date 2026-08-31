import type { Meta, StoryObj } from '@storybook/react-vite';

import { ErrorBoundary } from './error-boundary';

function ThrowingChild({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

const meta = {
  title: 'Components/ErrorBoundary',
  component: ErrorBoundary,
  decorators: [
    (story) => (
      <div className="h-64 w-96 rounded-lg border border-border">{story()}</div>
    ),
  ],
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

// The boundary's whole job is catching a render throw, so the useful story is
// the fallback it shows — not the pass-through happy path, which is just
// `children`.
export const Playground: Story = {
  args: {
    children: (
      <ThrowingChild message="Cannot read properties of undefined (reading 'id')" />
    ),
  },
};

export const LongErrorMessage: Story = {
  args: {
    children: (
      <ThrowingChild message="TypeError: Cannot read properties of undefined (reading 'items') at ChatTranscript (chats/Chats.tsx:412:18) at renderWithHooks (react-dom.development.js:16305:18) at mountIndeterminateComponent (react-dom.development.js:20074:13)" />
    ),
  },
};
