import { cn } from './ui/utils';

/**
 * One activatable sidebar list row (chats, workflow library, …): title +
 * subtitle, active highlight, and full keyboard activation. Promoted from the
 * identical inline rows in Chats and Graphs so the interaction/a11y behavior
 * is maintained once.
 */
export function NavListItem({
  active,
  title,
  subtitle,
  onActivate,
}: {
  active: boolean;
  title: string;
  subtitle?: string;
  onActivate: () => void;
}): React.JSX.Element {
  return (
    <li
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50',
        active && 'bg-accent shadow-[inset_0_0_0_1px_var(--border)]',
      )}
      role="button"
      tabIndex={0}
      aria-current={active ? true : undefined}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}>
      <span className="truncate text-sm font-medium">{title}</span>
      {subtitle ? (
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      ) : null}
    </li>
  );
}
