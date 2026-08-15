import { cn } from './ui/utils';

/**
 * One activatable sidebar list row: active highlight and full keyboard
 * activation. Content is either the default title/subtitle stack or, for
 * richer rows, custom `children`.
 *
 * Its one consumer today is the chat list (`chats/chat-list-item.tsx`) — the
 * Graphs library renders `WorkflowCard` tiles, not list rows. It lives in
 * `components/` anyway because the a11y structure below is the part worth
 * maintaining once, and any future sidebar list needs exactly it.
 *
 * Structure: the li keeps its listitem semantics ("x of N" enumeration) and
 * the activation surface is a REAL button layered under the content — ARIA
 * forbids interactive descendants inside a button role, and the chat row
 * nests a rename control. The content stack is pointer-events-none so row
 * clicks reach the overlay button; nested interactive elements re-enable
 * their own pointer events (`[&_button]`, `[&_a]`, `[&_input]` — an inline
 * rename field is the third, and a bare `<input>` would otherwise inherit
 * `pointer-events-none` and be unclickable).
 */
export function NavListItem({
  active,
  title,
  subtitle,
  className,
  children,
  onActivate,
  activateLabel,
  suspendActivation = false,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  active: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  children?: React.ReactNode;
  onActivate: () => void;
  /** Accessible name of the activation button (defaults to `title`). */
  activateLabel?: string;
  /**
   * Drop the whole-row activation surface while a nested control owns the
   * row (the chat row's inline rename). Re-enabling pointer events on the
   * input is not enough on its own: the overlay spans the entire row, so it
   * still swallows every click BESIDE the field — including the one that ends
   * an edit — and stays in the tab order competing for focus with it.
   */
  suspendActivation?: boolean;
  /**
   * Dragging the ROW itself — the chat list moves a conversation into a group
   * by dragging it there.
   *
   * On the `li` rather than on the content stack: the activation overlay spans
   * the row and would otherwise be what the pointer grabs, so a drag begun
   * anywhere but the text would do nothing. Only the two ENDS of the gesture
   * are here — where it lands is the drop zone's business, and `dragover`
   * bubbles up to it.
   */
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: (event: React.DragEvent) => void;
}): React.JSX.Element {
  return (
    <li
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'relative flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 hover:bg-accent/50',
        active && 'bg-accent shadow-[inset_0_0_0_1px_var(--border)]',
        className,
      )}>
      {suspendActivation ? null : (
        <button
          type="button"
          aria-label={activateLabel ?? title}
          aria-current={active ? true : undefined}
          onClick={onActivate}
          className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto">
        {children ?? (
          <>
            <span className="truncate text-sm font-medium">{title}</span>
            {subtitle ? (
              <span className="text-xs text-muted-foreground">{subtitle}</span>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
