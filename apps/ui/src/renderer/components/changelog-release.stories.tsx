import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChangelogReleaseCard } from './changelog-release';

const meta = {
  title: 'Components/ChangelogReleaseCard',
  component: ChangelogReleaseCard,
  args: {
    release: {
      version: '1.318.0',
      date: '2026-11-23',
      sections: [
        {
          kind: 'new',
          entries: [
            '**What’s new:** after an update, Geniro shows what changed since the version you last saw',
            'Search the changelog from Settings',
          ],
        },
        { kind: 'improved', entries: ['Faster start of a team run'] },
        {
          kind: 'fixed',
          entries: [
            'Keep the `context` readout answering while an agent works',
          ],
        },
        { kind: 'internal', entries: ['Move version parsing to one module'] },
      ],
    },
    current: false,
  },
  decorators: [(story) => <div className="max-w-2xl">{story()}</div>],
} satisfies Meta<typeof ChangelogReleaseCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A release with every kind of change. */
export const Default: Story = {};

/** The release the app is running, marked as current. */
export const Current: Story = { args: { current: true } };

/** Changes merged but not shipped in any release yet. */
export const Unreleased: Story = {
  args: {
    release: {
      version: null,
      date: null,
      sections: [
        { kind: 'fixed', entries: ['A fix waiting for the next release'] },
      ],
    },
  },
};
