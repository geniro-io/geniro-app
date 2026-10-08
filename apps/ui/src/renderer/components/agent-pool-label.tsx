import { HoverPopover } from './hover-popover';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';

/** One member of an agent's pool, as a label shows it. */
export interface PoolLabelMember {
  /** The CLI's short name (`claude`, `codex`). */
  name: string;
  /** The model it is set to, or null when it names none. */
  model: string | null;
  /** The config directory (profile) it runs under, or null for the default. */
  profile?: string | null;
}

/**
 * Which CLI drives an agent — and, for an agent POOL, every member behind one
 * label: `claude +1`, with the members listed on hover.
 *
 * REPORTED against a card carrying two badges, `claude` and `pool of 2`, the
 * second saying a pool exists and nothing about it: "instead of separate label
 * pool of 2 we can add like first agent type in pool + n inside same label, and
 * when we hover on this label we will see list of all agents there". Member 1
 * leads because it is the node's own settings — what its own conversation runs
 * on — and a call may land on any of the rest.
 *
 * An agent with ONE member is a plain badge with no panel: there is nothing
 * to list, and a hover that restates the badge is a control with nothing
 * behind it.
 */
export function AgentPoolLabel({
  members,
  variant = 'muted',
  leading = null,
  slot = 'agent-pool-label',
  className,
}: {
  /** Member 1 first. */
  members: readonly PoolLabelMember[];
  variant?: 'muted' | 'default' | 'outline';
  /** Drawn before the name — a CLI glyph. */
  leading?: React.ReactNode;
  slot?: string;
  className?: string;
}): React.JSX.Element | null {
  const first = members[0];
  if (first === undefined) {
    return null;
  }
  const extra = members.length - 1;
  const badge = (
    <Badge variant={variant} className={cn('gap-1', className)}>
      {leading}
      {first.name}
      {extra > 0 ? (
        <span data-slot="agent-pool-extra" className="opacity-70">
          +{extra}
        </span>
      ) : null}
    </Badge>
  );
  if (extra === 0) {
    return <span data-slot={slot}>{badge}</span>;
  }
  return (
    <HoverPopover
      slot={slot}
      label={`Agent pool: ${members.map((member) => member.name).join(', ')}`}
      panelLabel="Agent pool members"
      triggerClassName="rounded-md"
      panelClassName="w-72"
      trigger={badge}>
      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-[11px] text-muted-foreground">
          A call to this agent may run on any member.
        </p>
        <ol
          data-slot="agent-pool-members"
          className="m-0 flex list-none flex-col gap-1 p-0">
          {members.map((member, index) => (
            <li
              // Members are positional — their number IS their identity.
              key={index}
              data-slot="agent-pool-member"
              className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <span className="w-3 shrink-0 text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              {/* The profile on a line of its own: beside the model on one row
                  both were cut to a few letters in the panel's width. */}
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 font-medium">{member.name}</span>
                  {member.model === null ? null : (
                    <span
                      className="min-w-0 truncate text-muted-foreground"
                      title={member.model}>
                      {member.model}
                    </span>
                  )}
                </span>
                {member.profile ? (
                  <span
                    className="truncate text-[11px] text-muted-foreground"
                    title={member.profile}>
                    {profileLeaf(member.profile)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </HoverPopover>
  );
}

/** A profile directory's last component — what tells two profiles apart. */
function profileLeaf(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}
