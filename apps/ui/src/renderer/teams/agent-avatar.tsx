import { cn } from '../components/ui/utils';

/**
 * Up-to-two-letter initials for a node avatar — first letters of the first two
 * words, or the first two characters of a single word. Mirrors geniro's agent
 * avatars so the desktop builder reads the same.
 */
export function agentInitials(label: string): string {
  const words = label
    .trim()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const [first, second] = words;
  if (!first) {
    return '?';
  }
  if (!second) {
    return first.slice(0, 2).toUpperCase();
  }
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

/**
 * The round initials chip shown on an agent node and in the node inspector.
 * One component so both surfaces stay visually identical (design-system reuse).
 */
export function AgentAvatar({
  label,
  className,
}: {
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary',
        className,
      )}>
      {agentInitials(label)}
    </span>
  );
}
