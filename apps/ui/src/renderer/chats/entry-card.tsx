import { memo } from 'react';

import { ChartCard } from './chart-block';
import { ComparisonCard } from './comparison-block';
import { FindingsCard } from './findings-block';
import { GalleryCard } from './gallery-block';
import { MetricsCard } from './metrics-block';
import { TaskListCard } from './task-list';
import type { CardEntry } from './transcript-groups';
import { WorkflowCard } from './workflow-block';

/**
 * The ONE place a {@link CardEntry} becomes its card.
 *
 * Both transcript flows spelled the same seven-arm chain — the messenger frame
 * and the folded turn block — so a new card kind was two edits, and the missed
 * one rendered NOTHING rather than failing, which is the quietest way a row can
 * go missing. `isCardEntry` already made "is this a card?" one question for six
 * readers; this makes "which card is it?" one answer for the two that draw one.
 *
 * The switch carries no `default` AND the return type is annotated, and it
 * takes both for the compiler to keep this list in step with `CardEntry`. The
 * `default`-free switch alone does not: this project leaves `noImplicitReturns`
 * off, and a component may return `undefined`, so a missing arm compiles clean
 * and renders nothing. The annotation is what turns that into TS2366 — dropping
 * it silently restores the silent-absence failure this file exists to prevent.
 *
 * No sender frame anywhere here: each of these is something the agent handed
 * the app to DRAW rather than something it said, and the turn block around it
 * already names who was working.
 *
 * `memo` because this draws once per card row in a transcript that re-renders
 * at streamed-token rate.
 */
export const EntryCard = memo(function EntryCard({
  entry,
}: {
  entry: CardEntry;
}): React.JSX.Element {
  switch (entry.type) {
    case 'task-list':
      return <TaskListCard entry={entry} />;
    case 'findings':
      return <FindingsCard report={entry.report} />;
    case 'chart':
      return <ChartCard chart={entry.chart} />;
    case 'metrics':
      return <MetricsCard metrics={entry.metrics} />;
    case 'comparison':
      return <ComparisonCard comparison={entry.comparison} />;
    case 'gallery':
      return <GalleryCard gallery={entry.gallery} />;
    case 'workflow':
      return <WorkflowCard entry={entry} />;
  }
});
