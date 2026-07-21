import { cn } from './ui/utils';

/**
 * One activatable sidebar list row (chats, workflow library, …): active
 * highlight and full keyboard activation. Promoted from the identical inline
 * rows in Chats and Graphs so the interaction/a11y behavior is maintained
 * once. Content is either the default title/subtitle stack or, for richer
 * rows (the chat list), custom `children`.
 *
 * Structure: the li keeps its listitem semantics ("x of N" enumeration) and
 * the activation surface is a REAL button layered under the content — ARIA
 * forbids interactive descendants inside a button role, and the chat row
 * nests a rename control. The content stack is pointer-events-none so row
 * clicks reach the overlay button; nested interactive elements re-enable
 * their own pointer events (`[&_button]:pointer-events-auto`).
 */
export function NavListItem({
  active,
  title,
  subtitle,
  className,
  children,
  onActivate,
  activateLabel,
}: {
  active: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  children?: React.ReactNode;
  onActivate: () => void;
  /** Accessible name of the activation button (defaults to `title`). */
  activateLabel?: string;
}): React.JSX.Element {
  return (
    <li
      className={cn(
        'relative flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 hover:bg-accent/50',
        active && 'bg-accent shadow-[inset_0_0_0_1px_var(--border)]',
        className,
      )}>
      <button
        type="button"
        aria-label={activateLabel ?? title}
        aria-current={active ? true : undefined}
        onClick={onActivate}
        className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
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
