import { InitialsAvatar } from '../components/ui/avatar';
import { cn } from '../components/ui/utils';

/**
 * Geniro web's ChatBubble frame: the sender's solid-colour initials avatar
 * beside the content, and ONE metadata line UNDER it — `sender · time` —
 * mirrored to the right for the user's own messages. (No name line above;
 * identity lives in the metadata, exactly like the reference.)
 */
// Deliberately NOT memoized: every call site passes fresh inline `children`
// JSX, so a memo's shallow compare could never bail out here — the render win
// comes from the memoized TranscriptEntryView shell above its main call sites.
export function SenderRow({
  name,
  avatarName,
  colorKey,
  solid = false,
  align = 'start',
  time,
  children,
}: {
  /** Sender name shown in the metadata line. */
  name: string;
  /** Name the avatar initials derive from (defaults to `name`). */
  avatarName?: string;
  /** Deterministic avatar colour key (a node id); defaults to the name. */
  colorKey?: string;
  /** The user's own neutral-gray avatar. */
  solid?: boolean;
  align?: 'start' | 'end';
  /** Time metadata; empty hides that segment. */
  time?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const reversed = align === 'end';
  return (
    <div
      data-slot="sender-row"
      className={cn('flex w-full gap-3', reversed && 'flex-row-reverse')}>
      <InitialsAvatar
        name={avatarName ?? name}
        colorKey={colorKey}
        solid={solid}
      />
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          reversed ? 'items-end' : 'items-start',
        )}>
        {children}
        <div
          className={cn(
            'mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground',
            reversed && 'flex-row-reverse',
          )}>
          <span className="font-medium text-foreground/60">{name}</span>
          {time ? (
            <>
              <span>·</span>
              <span>{time}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
