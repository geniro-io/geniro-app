import { cn } from './ui/utils';

/**
 * One activatable sidebar list row (chats, workflow library, …): active
 * highlight and full keyboard activation. Promoted from the identical inline
 * rows in Chats and Graphs so the interaction/a11y behavior is maintained
 * once. Content is either the default title/subtitle stack or, for richer
 * rows (the chat list), custom `children`.
 */
export function NavListItem({
  active,
  title,
  subtitle,
  className,
  children,
  onActivate,
}: {
  active: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  children?: React.ReactNode;
  onActivate: () => void;
}): React.JSX.Element {
  return (
    <li
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50',
        active && 'bg-accent shadow-[inset_0_0_0_1px_var(--border)]',
        className,
      )}
      role="button"
      tabIndex={0}
      aria-current={active ? true : undefined}
      onClick={onActivate}
      onKeyDown={(event) => {
        // Only activate for keys pressed ON the row itself — a focused inner
        // control (e.g. the chat row's rename button) handles its own Enter.
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}>
      {children ?? (
        <>
          <span className="truncate text-sm font-medium">{title}</span>
          {subtitle ? (
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          ) : null}
        </>
      )}
    </li>
  );
}
