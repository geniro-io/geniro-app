import { cn } from './utils';

/**
 * Agent avatar palette — mirrors geniro web's AGENT_AVATAR_COLORS via the
 * avatar-* tokens; the colour is hashed from the node id (stable across
 * renames) with the display name as fallback.
 */
const TONES = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
  'bg-avatar-7',
  'bg-avatar-8',
] as const;

/** Mirrors geniro web's AgentAvatar SIZE_MAP (sm = pair chips, md = rows). */
const SIZES = {
  sm: 'size-5 text-[9px]',
  md: 'size-8 text-[11px]',
} as const;

function hashKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** The tone class for a colour key — exported so avatar pairs can share it. */
export function avatarTone(colorKey: string): string {
  return TONES[hashKey(colorKey) % TONES.length]!;
}

/**
 * The auto-generated initials for a display name: first letter of the first
 * two words ("Flaky (cursor)" → "FC"), a single word keeps one letter
 * ("Poet" → "P") — geniro web's getAgentInitials.
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
 * Messenger-style sender icon: a solid colour circle with the name's
 * auto-generated initials in white — geniro web's AgentAvatar. `solid`
 * (the user's own avatar) renders the neutral gray variant.
 */
export function InitialsAvatar({
  name,
  colorKey,
  solid = false,
  size = 'md',
  className,
}: {
  name: string;
  /** Drives the deterministic colour (a node id); defaults to `name`. */
  colorKey?: string;
  /** The user's own neutral-gray avatar. */
  solid?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-slot="avatar"
      aria-hidden="true"
      title={name}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-primary-foreground uppercase select-none',
        SIZES[size],
        solid ? 'bg-avatar-user' : avatarTone(colorKey ?? name),
        className,
      )}>
      {initialsOf(name)}
    </span>
  );
}
