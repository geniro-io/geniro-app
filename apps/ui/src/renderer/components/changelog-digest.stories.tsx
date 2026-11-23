import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChangelogDigest } from './changelog-digest';

const meta = {
  title: 'Components/ChangelogDigest',
  component: ChangelogDigest,
  args: {
    releases: [
      {
        version: '1.318.0',
        date: '2026-11-24',
        sections: [
          {
            kind: 'new',
            entries: [
              '**What’s new:** after an update, Geniro shows what changed since the version you last saw',
            ],
          },
          { kind: 'fixed', entries: ['Keep the `context` readout answering'] },
          { kind: 'internal', entries: ['Move version parsing to one module'] },
        ],
      },
      {
        version: '1.317.1',
        date: '2026-11-23',
        sections: [
          { kind: 'improved', entries: ['Open large threads in one frame'] },
          {
            kind: 'fixed',
            entries: ['Let codex’s built-in Apps server be switched off'],
          },
        ],
      },
      {
        version: '1.317.0',
        date: '2026-11-23',
        sections: [{ kind: 'new', entries: ['System analysis in Settings'] }],
      },
    ],
  },
  decorators: [(story) => <div className="max-w-2xl">{story()}</div>],
} satisfies Meta<typeof ChangelogDigest>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three releases as one list, each entry tagged with its release. */
export const Default: Story = {};

/** One release: no release tags, since every entry shipped in it. */
export const SingleRelease: Story = {
  args: {
    releases: [
      {
        version: '1.317.1',
        date: '2026-11-23',
        sections: [
          { kind: 'improved', entries: ['Open large threads in one frame'] },
        ],
      },
    ],
  },
};
