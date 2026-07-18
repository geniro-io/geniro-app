import { cn } from '../components/ui/utils';

/**
 * The one Cursor-style composer shell shared by BOTH message surfaces — the
 * new-run composer and the open transcript's follow-up composer — so they
 * stay visually identical: a rounded card that ring-highlights while the
 * textarea inside has focus. Content is the caller's (textarea on top, a
 * controls row underneath).
 */
export function ComposerCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card shadow-panel-md transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30',
        className,
      )}>
      {children}
    </div>
  );
}
