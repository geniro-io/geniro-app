import { type AvatarLook, MemberAvatar } from '../components/member-avatar';

/**
 * One member's share of the team's work: face, name, a share bar and three
 * figures the daemon measured. A figure nothing measured is a dash.
 */
export function MemberBreakdownRow({
  memberId,
  name,
  avatar,
  share,
  figures,
  color = 'var(--color-chart-1)',
}: {
  memberId: string;
  name: string;
  avatar?: AvatarLook | null;
  /** Fraction of the team's total, 0–1; null when not measured. */
  share: number | null;
  figures: readonly [string | null, string | null, string | null];
  color?: string;
}): React.JSX.Element {
  const percent = share === null ? null : Math.round(share * 100);
  return (
    <li
      data-slot="member-breakdown-row"
      className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-4 rounded-control px-3 py-2 max-sm:grid-cols-[minmax(0,1fr)_auto]">
      <span className="flex min-w-0 items-center gap-2">
        <MemberAvatar
          name={name}
          avatar={avatar}
          colorKey={memberId}
          size={24}
        />
        <span className="truncate text-base">{name}</span>
      </span>
      <span className="flex items-center gap-2 max-sm:hidden">
        <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-muted">
          <span
            aria-hidden="true"
            className="block h-full rounded-pill"
            style={{ width: `${percent ?? 0}%`, backgroundColor: color }}
          />
        </span>
        <span className="w-10 text-right text-sm text-muted-foreground tabular-nums">
          {percent === null ? '—' : `${percent}%`}
        </span>
      </span>
      <span className="flex gap-4 text-sm text-muted-foreground tabular-nums">
        {figures.map((value, index) => (
          <span key={index} className="w-14 text-right">
            {value ?? '—'}
          </span>
        ))}
      </span>
    </li>
  );
}
