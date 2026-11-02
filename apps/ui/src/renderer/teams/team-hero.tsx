import { plural } from '../chats/run-outcome';
import { type AvatarPerson, AvatarStack } from '../components/member-avatar';

/**
 * What the team has done, as the daemon measured it. A figure nothing
 * measured is null and shows as a dash.
 */
export interface TeamFigures {
  runs: number | null;
  cost: string | null;
  worked: string | null;
}

export const UNMEASURED_FIGURES: TeamFigures = {
  runs: null,
  cost: null,
  worked: null,
};

function figure(value: string | number | null): string {
  return value === null ? '—' : String(value);
}

/**
 * The top of a team's page: its people, its name and purpose, how big it is
 * and what it has done, and anything it needs before it runs well.
 */
export function TeamHero({
  name,
  description,
  people,
  memberCount,
  stageCount,
  figures,
  warning,
}: {
  name: string;
  description: string | null | undefined;
  people: readonly AvatarPerson[];
  memberCount: number;
  stageCount: number;
  figures: TeamFigures;
  /** The setup-problems pill, or null. */
  warning?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      data-slot="team-hero"
      aria-label={name}
      className="flex gap-5 max-sm:flex-col max-sm:gap-4">
      <AvatarStack
        people={people}
        total={memberCount}
        max={6}
        size={48}
        className="shrink-0 self-start pt-1"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="min-w-0 text-title font-semibold break-words">
            {name}
          </h2>
          {warning}
        </div>
        {description?.trim() ? (
          <p className="text-base text-muted-foreground">{description}</p>
        ) : null}
        <p
          data-slot="team-figures"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
          <span>
            {plural(memberCount, 'member', 'members')} ·{' '}
            {plural(stageCount, 'stage', 'stages')}
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-border" />
          <span>
            Runs {figure(figures.runs)} · Cost {figure(figures.cost)} · Worked{' '}
            {figure(figures.worked)}
          </span>
        </p>
      </div>
    </section>
  );
}
