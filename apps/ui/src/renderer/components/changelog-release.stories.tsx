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
            {
              text: '**What’s new:** after an update, Geniro shows what changed since the version you last saw',
              description:
                'The first launch after an update opens a short note with every new feature, improvement and fix since the version you had before.',
            },
            { text: 'Search the changelog from Settings' },
          ],
        },
        { kind: 'improved', entries: [{ text: 'Faster start of a team run' }] },
        {
          kind: 'fixed',
          entries: [
            {
              text: 'Keep the `context` readout answering while an agent works',
            },
          ],
        },
        {
          kind: 'internal',
          entries: [{ text: 'Move version parsing to one module' }],
        },
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
        {
          kind: 'fixed',
          entries: [{ text: 'A fix waiting for the next release' }],
        },
      ],
    },
  },
};
