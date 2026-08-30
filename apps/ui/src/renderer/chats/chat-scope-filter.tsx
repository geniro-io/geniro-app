import { Archive, Filter, ListFilter, MessageSquare } from 'lucide-react';
import React, { useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Menu } from '../components/ui/menu';
import { SIDEBAR_MENU_WIDTH } from './group-header';
import type { ChatListScope } from './use-chat-run';

/** The rows, in the order they are offered. */
const SCOPES = [
  {
    value: 'active',
    label: 'Active chats',
    icon: <MessageSquare />,
  },
  { value: 'all', label: 'Show all', icon: <ListFilter /> },
  { value: 'archived', label: 'Archived only', icon: <Archive /> },
] as const satisfies readonly {
  value: ChatListScope;
  label: string;
  icon: React.ReactNode;
}[];

const isScope = (value: string): value is ChatListScope =>
  SCOPES.some((scope) => scope.value === value);

/**
 * What the chat sidebar lists — one icon in the header's control row, opening
 * the three scopes.
 *
 * An ICON among the other three rather than a band of its own, which is what it
 * replaced: a two-option segmented control sat under the heading as a fourth
 * row of chrome above a list, and it could only ever name two of the three
 * answers. Reported as "у нас не должно быть этого элемента интерфейса… должна
 * быть отдельная маленькая иконка, там же, где сверху другие три иконки".
 *
 * The trigger is TONED when the listing is narrowed away from the default, and
 * that is the whole of what a collapsed control owes its user: an icon that
 * looked identical in all three states would leave "why is this thread
 * missing?" with nothing on screen to answer it. The current scope is also on
 * the hover title, since colour is not a label.
 */
export function ChatScopeFilter({
  scope,
  onChange,
}: {
  scope: ChatListScope;
  onChange: (next: ChatListScope) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const current = SCOPES.find((entry) => entry.value === scope) ?? SCOPES[0];

  return (
    <span className="relative inline-flex">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        data-menu-trigger
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter chats"
        title={`Filter chats · ${current.label}`}
        className={
          scope === 'active'
            ? 'size-7'
            : 'size-7 text-primary hover:text-primary'
        }
        onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <Filter className="shrink-0" />
      </Button>
      <Menu
        open={open}
        side="bottom"
        align="end"
        anchor="viewport"
        triggerRef={triggerRef}
        // The same width as the sidebar's other menu (a group's colours), so
        // the two panels in this column are one shape. Its default is wide
        // enough to reach across the nav rail beside it.
        className={SIDEBAR_MENU_WIDTH}
        value={scope}
        groups={[{ label: 'Show', items: [...SCOPES] }]}
        onSelect={(value) => {
          setOpen(false);
          if (isScope(value)) {
            onChange(value);
          }
        }}
        onClose={() => setOpen(false)}
      />
    </span>
  );
}
