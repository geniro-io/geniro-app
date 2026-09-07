import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { EmptyState } from './empty-state';
import { SearchField, SearchResultList, SearchSnippet } from './search-panel';

function Hit({
  title,
  snippet,
}: {
  title: string;
  snippet?: string;
}): React.JSX.Element {
  return (
    <li>
      <div className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 hover:bg-sidebar-accent">
        <span className="w-full text-sm text-foreground">{title}</span>
        {snippet === undefined ? null : (
          <SearchSnippet>{snippet}</SearchSnippet>
        )}
      </div>
    </li>
  );
}

const ROWS = (
  <ul className="m-0 flex list-none flex-col p-1">
    <Hit
      title="Sizing the bloom filter"
      snippet="…the false-positive rate is a function of the bit count, so the filter has to be sized from the expected cardinality…"
    />
    <Hit
      title="asar deletion under Electron"
      snippet="…fs.rm walks INTO the archive rather than deleting it — 45 seconds and still running…"
    />
    <Hit title="No quote on this one" />
  </ul>
);

const meta = {
  title: 'Components/SearchPanel',
  component: SearchResultList,
  args: {
    loading: false,
    loadingLabel: 'Searching…',
    isEmpty: false,
    empty: <EmptyState>Nothing matches that search</EmptyState>,
    children: ROWS,
  },
  // The list is `flex-1` inside a column, so it needs a box with a height to
  // show its own scrolling rather than growing to fit its rows.
  decorators: [
    (story) => (
      <div className="flex h-[22rem] w-[34rem] flex-col gap-3">{story()}</div>
    ),
  ],
} satisfies Meta<typeof SearchResultList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Hits: Story = {};

export const Loading: Story = {
  args: { loading: true, loadingLabel: 'Searching this conversation…' },
};

export const Empty: Story = {
  args: { isEmpty: true },
};

/** Nothing could be searched at all — this REPLACES the rows. */
export const Unavailable: Story = {
  args: {
    unavailableReason:
      'cursor-agent cannot search inside its conversations — its transcripts are only readable one at a time.',
  },
};

/** The rows are real but not all of them — this sits UNDER the rows. */
export const Partial: Story = {
  args: {
    partialReason: 'showing the newest 50 matches — add a word to narrow it',
  },
};

/**
 * The whole surface as a caller assembles it. The field is a separate export
 * precisely so it can share a row with other controls, which is why it is not
 * built into the list.
 */
export const WithField: Story = {
  render: (args) => {
    const [query, setQuery] = useState('bloom');
    return (
      <>
        <SearchField
          label="Search this conversation"
          placeholder="Search by what was said…"
          value={query}
          onValueChange={setQuery}
        />
        <SearchResultList {...args} />
      </>
    );
  },
};
