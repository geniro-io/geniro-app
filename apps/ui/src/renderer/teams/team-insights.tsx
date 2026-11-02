import { BarChart3, Brain, Search } from 'lucide-react';

import { EmptyState } from '../components/empty-state';
import { Input } from '../components/ui/input';
import { SERIES } from '../stats/charts/chart-theme';
import { KpiStrip, KpiTile } from './kpi-tile';

/**
 * The Statistics tab. Every figure is the daemon's; until it serves a team's
 * readings the tab says there are no runs to count.
 */
export function TeamStatsTab({
  runs,
}: {
  /** Runs the daemon counted for this team; null while not measured. */
  runs: number | null;
}): React.JSX.Element {
  return (
    <div data-slot="team-stats" className="flex flex-col gap-8">
      <KpiStrip>
        <KpiTile
          caption="Runs"
          value={runs === null ? null : String(runs)}
          color={SERIES.threads}
        />
        <KpiTile caption="Cost" value={null} color={SERIES.spend} />
        <KpiTile caption="Turns" value={null} color={SERIES.tokens} />
        <KpiTile caption="Worked time" value={null} color={SERIES.avgTime} />
        <KpiTile caption="Outcomes" value={null} color={SERIES.pullRequests} />
      </KpiStrip>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-base font-semibold">By member</h3>
          <p className="text-sm text-muted-foreground">
            Who did the work, and what it cost.
          </p>
        </div>
        <EmptyState icon={<BarChart3 aria-hidden="true" />}>
          No runs yet.
        </EmptyState>
      </section>
    </div>
  );
}

/** The Memory tab: the team's memories, searchable, each opening in Settings. */
export function TeamMemoryTab({
  query,
  onQueryChange,
  children,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  /** The memory rows; nothing renders the empty state. */
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-slot="team-memory" className="flex flex-col gap-4">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search team memories"
          placeholder="Search team memories"
          value={query}
          className="h-10 rounded-control pl-9"
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      {children ?? (
        <EmptyState icon={<Brain aria-hidden="true" />}>
          No team memories yet.
        </EmptyState>
      )}
    </div>
  );
}
