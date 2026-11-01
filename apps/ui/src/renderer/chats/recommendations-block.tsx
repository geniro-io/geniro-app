import { useContext, useState } from 'react';

import {
  RecommendationsCard,
  type RecommendationsLook,
} from '../components/recommendations-card';
import { describeDaemonError } from '../daemon-api';
import { categoryToken } from '../stats/charts/chart-theme';
import { formatDuration, formatPercent } from '../stats/stats-format';
import { formatUsd } from './agent-activity';
import { RecommendationsApplyContext } from './recommendations-apply-context';
import { useThreadFlags } from './thread-ui-memory';
import type { RecommendationsEntry } from './transcript-groups';

const LOOK: RecommendationsLook = {
  formatMs: formatDuration,
  formatUsd,
  formatPercent,
  sinkColor: categoryToken,
};

/**
 * A `recommendations` row as its card: the transcript's view of the card
 * (what was applied, each item's outcome) plus the one press it takes.
 *
 * The selection is shown as sent from the moment the daemon accepts it, ahead
 * of the message row that records it reaching this window.
 */
export function RecommendationsBlock({
  entry,
}: {
  entry: RecommendationsEntry;
}): React.JSX.Element {
  const apply = useContext(RecommendationsApplyContext);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flags = useThreadFlags();
  const foldKey = (key: string): string => `recommendations:${entry.id}:${key}`;
  return (
    <RecommendationsCard
      look={LOOK}
      selection={{
        picked: entry.card.items
          .map((item) => item.id)
          .filter((id) => flags.get(foldKey(`pick:${id}`)) ?? false),
        setPicked: (ids) => {
          for (const item of entry.card.items) {
            flags.set(foldKey(`pick:${item.id}`), ids.includes(item.id));
          }
        },
      }}
      folds={{
        isOpen: (key) => flags.get(foldKey(key)) ?? false,
        toggle: (key) =>
          flags.set(foldKey(key), !(flags.get(foldKey(key)) ?? false)),
      }}
      summary={entry.card.summary}
      timing={entry.card.timing}
      teamStats={entry.card.teamStats}
      hotspots={entry.card.hotspots}
      team={entry.card.sourceKind === 'team'}
      items={entry.card.items}
      applied={entry.applied ?? sent}
      outcomes={entry.outcomes}
      sending={sending}
      error={error}
      onDismissError={() => setError(null)}
      onApply={
        apply === null
          ? undefined
          : (ids) => {
              setSending(true);
              setError(null);
              apply(entry.runId, entry.seq, ids)
                .then(() => setSent(ids))
                .catch((err: unknown) => setError(describeDaemonError(err)))
                .finally(() => setSending(false));
            }
      }
    />
  );
}
