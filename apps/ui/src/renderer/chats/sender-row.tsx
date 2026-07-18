import { InitialsAvatar } from '../components/ui/avatar';
import { cn } from '../components/ui/utils';

/**
 * Messenger-style frame around one transcript entry: the sender's initials
 * avatar in the gutter, the sender name above the content, and the time
 * metadata line under it. The user's own messages mirror to the right with
 * the solid avatar.
 */
export function SenderRow({
  name,
  avatarName,
  solid = false,
  align = 'start',
  time,
  children,
}: {
  /** Display name on the header line. */
  name: string;
  /** Name the avatar initials derive from (defaults to `name`). */
  avatarName?: string;
  /** The user's own filled avatar style. */
  solid?: boolean;
  align?: 'start' | 'end';
  /** Clock-time metadata under the content; empty hides the line. */
  time?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="sender-row"
      className={cn(
        'flex w-full items-start gap-2',
        align === 'end' && 'flex-row-reverse',
      )}>
      <InitialsAvatar name={avatarName ?? name} solid={solid} />
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1',
          align === 'end' ? 'items-end' : 'items-start',
        )}>
        <span className="text-[11px] leading-none font-medium text-muted-foreground">
          {name}
        </span>
        {children}
        {time ? (
          <span className="text-[10px] leading-none text-muted-foreground/80">
            {time}
          </span>
        ) : null}
      </div>
    </div>
  );
}
