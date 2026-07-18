import { cn } from './utils';

/**
 * Deterministic avatar tones, hashed from the name so an agent keeps its
 * colour across runs. Token-only combinations (design-system rule).
 */
const TONES = [
  'bg-primary/15 text-primary',
  'bg-success/15 text-success',
  'bg-warning/15 text-warning',
  'bg-sidebar-accent text-foreground',
] as const;

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * The auto-generated initials for a display name: first letter of the first
 * two words ("Flaky (cursor)" → "FC"), a single word keeps one letter
 * ("Poet" → "P").
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 2);
  if (words.length === 0) {
    return '?';
  }
  return words.map((word) => word[0]!.toUpperCase()).join('');
}

/**
 * Messenger-style sender icon: a circle with the name's auto-generated
 * initials and a deterministic per-name tone. `solid` is the user's own
 * avatar (filled primary, like the user bubble).
 */
export function InitialsAvatar({
  name,
  solid = false,
  className,
}: {
  name: string;
  solid?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-slot="avatar"
      aria-hidden="true"
      title={name}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold uppercase select-none',
        solid
          ? 'bg-primary text-primary-foreground'
          : TONES[hashName(name) % TONES.length],
        className,
      )}>
      {initialsOf(name)}
    </span>
  );
}
