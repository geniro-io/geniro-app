import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import {
  type FindingOutcome,
  type FindingRow,
  type FindingsReport,
  findingsSummary,
  type FindingVerdict,
  groupFindingsByFile,
} from './findings-payload';

/**
 * A code-review findings report, drawn as the card the agent could not draw for
 * itself.
 *
 * The whole point of the mechanism: the agent hands over typed findings and
 * spends none of its output on formatting them, so the transcript can group
 * them by file, badge them, and keep the long half behind a disclosure —
 * none of which survives being printed as markdown.
 *
 * Built from primitives rather than on `DisclosureRow`: that row's three tones
 * are `destructive` / `warning` / `muted` and its whole contract is a FAILURE
 * the user is being warned about — it leads with a warning triangle and renders
 * its body as monospace `<pre>`. A finding is a claim about code, not a
 * malfunction of this app, and dressing it in the failure chrome is the same
 * mistake that row's own doc block records having been reported once already.
 */

const VERDICT_BADGE: Record<
  FindingVerdict,
  { variant: 'destructive' | 'secondary'; label: string }
> = {
  CONFIRMED: { variant: 'destructive', label: 'Confirmed' },
  PLAUSIBLE: { variant: 'secondary', label: 'Plausible' },
};

const OUTCOME_BADGE: Record<
  FindingOutcome,
  { variant: 'success' | 'muted'; label: string }
> = {
  fixed: { variant: 'success', label: 'Fixed' },
  skipped: { variant: 'muted', label: 'Skipped' },
  no_change_needed: { variant: 'muted', label: 'No change needed' },
};

/** `src/a.ts:42 · correctness` — the finding's own coordinates, in one line. */
function locationOf(finding: FindingRow): string {
  const at =
    finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return finding.category === null ? at : `${at} · ${finding.category}`;
}

function FindingDisclosure({
  finding,
}: {
  finding: FindingRow;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const verdict =
    finding.verdict === null ? null : VERDICT_BADGE[finding.verdict];
  const outcome =
    finding.outcome === null ? null : OUTCOME_BADGE[finding.outcome];
  return (
    <div
      data-slot="finding-row"
      // Stated on the element because neither is derivable from the outside: a
      // test (and anyone with the inspector open) has no other way to see which
      // way the disclosure went, or which badge decided the row's tone.
      data-open={open}
      data-verdict={finding.verdict ?? 'none'}
      className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-normal transition-colors hover:bg-muted/50">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        {verdict ? (
          <Badge variant={verdict.variant} className="shrink-0">
            {verdict.label}
          </Badge>
        ) : null}
        {outcome ? (
          <Badge variant={outcome.variant} className="shrink-0">
            {outcome.label}
          </Badge>
        ) : null}
        {/* The short label when the agent wrote one — it was asked for a line
            that fits beside two badges — and the full sentence when it did not,
            truncated rather than dropped. */}
        <span className="min-w-0 flex-1 truncate">
          {finding.shortSummary ?? finding.summary}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 px-3 pb-2 pl-[1.9rem] text-xs leading-relaxed">
          <p className="m-0">{finding.summary}</p>
          {finding.failureScenario === null ? null : (
            <div>
              <SectionLabel>How it fails</SectionLabel>
              <p className="m-0 text-muted-foreground">
                {finding.failureScenario}
              </p>
            </div>
          )}
          {/* Selectable, and monospace, because what a reader does with it is
              paste it somewhere — there is no jump from here yet. */}
          <p className="m-0 font-mono text-[11px] text-muted-foreground">
            {locationOf(finding)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The card. Open to start: a report is the answer to something the user asked
 * for, so it arrives showing its findings rather than as a line to press.
 */
export function FindingsCard({
  report,
}: {
  report: FindingsReport;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const { total, confirmed, resolved } = findingsSummary(report);
  const groups = groupFindingsByFile(report.findings);
  const heading = [
    'Code review',
    report.level,
    total === 0
      ? 'no findings'
      : `${total} ${total === 1 ? 'finding' : 'findings'}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <div data-slot="findings-card" data-open={open} className="min-w-0">
      <SectionLabel>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1">
          <ChevronRight
            aria-hidden="true"
            className={cn('size-3 transition-transform', open && 'rotate-90')}
          />
          {heading}
          {/* Only where they say something the heading does not: a report whose
              every finding is confirmed, or one that has not been acted on, has
              nothing to add here. */}
          {confirmed > 0 && confirmed < total
            ? ` · ${confirmed} confirmed`
            : ''}
          {resolved > 0 ? ` · ${resolved} resolved` : ''}
        </button>
      </SectionLabel>
      {open ? (
        total === 0 ? (
          // An empty report is a RESULT — the agent reviewed and nothing
          // survived its verification — so it says so rather than rendering as
          // an empty card the reader has to interpret.
          <p className="m-0 px-1 text-xs text-muted-foreground">
            The review finished with nothing to report.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.map((group) => (
              <div key={group.file} className="min-w-0">
                <p
                  data-slot="finding-file"
                  className="m-0 mb-0.5 truncate px-1 font-mono text-[11px] text-muted-foreground">
                  {group.file}
                </p>
                {group.findings.map((finding, index) => (
                  <FindingDisclosure
                    // Index-keyed within its file group: nothing in the payload
                    // identifies a finding, and two findings on one file+line
                    // are a thing an agent legitimately reports.
                    key={`${finding.file}:${finding.line ?? '-'}:${index}`}
                    finding={finding}
                  />
                ))}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
