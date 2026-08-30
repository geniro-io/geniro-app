import { Archive, MessageSquare } from 'lucide-react';
import type React from 'react';

import { SegmentedControl } from '../components/ui/segmented-control';

/** Which side of the archive the sidebar is showing. */
export type ChatListSide = 'active' | 'archived';

const SIDES = [
  { id: 'active', label: 'Active', icon: <MessageSquare /> },
  { id: 'archived', label: 'Archived', icon: <Archive /> },
] as const satisfies readonly {
  id: ChatListSide;
  label: string;
  icon: React.ReactNode;
}[];

/**
 * The chat sidebar's view switch — the threads on the desk, or the ones filed
 * away.
 *
 * Both sides are always drawn, which is not merely the control's style: the
 * inactive one is the whole affordance for finding the archive, so an
 * archived thread would otherwise have no visible way back.
 */
export function ArchiveFilter({
  archived,
  onChange,
}: {
  archived: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="px-3 pb-1">
      <SegmentedControl
        ariaLabel="Show"
        size="sm"
        options={SIDES}
        value={archived ? 'archived' : 'active'}
        onSelect={(side) => onChange(side === 'archived')}
      />
    </div>
  );
}
