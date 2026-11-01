import { ShieldAlert } from 'lucide-react';
import { memo } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { RUNS_UNASKED_LABEL } from '../teams/member-schema';
import type { DiffMarker, DiffRow } from './team-proposal-payload';
import { useThreadFlag } from './thread-ui-memory';

const MARKER: Record<DiffMarker, { glyph: string; word: string }> = {
  changed: { glyph: '~', word: 'changed' },
  added: { glyph: '+', word: 'added' },
  removed: { glyph: '−', word: 'removed' },
};

/** A value short enough to read inline, `before → after`. */
const INLINE_VALUE_CHARS = 60;

function inline(detail: NonNullable<DiffRow['detail']>): boolean {
  return [detail.before, detail.after].every(
    (value) => value.length <= INLINE_VALUE_CHARS && !value.includes('\n'),
  );
}

function subjectText(row: DiffRow): string {
  switch (row.scope) {
    case 'team':
      return `team ${row.subject}`;
    case 'member':
      return row.subject;
    case 'block':
      return `block ${row.subject}`;
    case 'stage':
      return `stage ${row.subject}`;
  }
}

/** One change, in words — the marker glyph is decoration beside them. */
function rowText(row: DiffRow): string {
  if (row.detail === null) {
    return `${subjectText(row)} ${MARKER[row.marker].word}`;
  }
  const head = `${subjectText(row)} · ${row.detail.field}`;
  return inline(row.detail)
    ? `${head}: ${row.detail.before} → ${row.detail.after}`
    : head;
}

/** A long value's two sides, one under the other, as a diff draws them. */
function ValueChange({
  detail,
}: {
  detail: NonNullable<DiffRow['detail']>;
}): React.JSX.Element {
  return (
    <span
      data-slot="team-diff-value"
      className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] leading-snug">
      <span className="flex gap-1.5 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-destructive">
        <span aria-hidden="true">−</span>
        <span className="sr-only">before: </span>
        <span className="min-w-0 whitespace-pre-wrap">{detail.before}</span>
      </span>
      <span className="flex gap-1.5 rounded-sm bg-success/10 px-1.5 py-0.5 text-success">
        <span aria-hidden="true">+</span>
        <span className="sr-only">after: </span>
        <span className="min-w-0 whitespace-pre-wrap">{detail.after}</span>
      </span>
    </span>
  );
}

/**
 * What a replacement changes against the saved team, one line per change,
 * every change that makes an agent run tools unasked first and tinted — the
 * ones a reader skimming the list must still see.
 *
 * Folds, open by default, remembered per thread under `memoryKey`.
 */
export const TeamDiffList = memo(function TeamDiffList({
  rows,
  memoryKey,
}: {
  /** In display order — `diffRows` puts the unasked ones first. */
  rows: readonly DiffRow[];
  memoryKey?: string;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(memoryKey, true);
  if (rows.length === 0) {
    return (
      <p data-slot="team-diff" className="m-0 text-xs text-muted-foreground">
        Identical to the saved team
      </p>
    );
  }
  const label = `${rows.length} ${rows.length === 1 ? 'change' : 'changes'}`;
  return (
    <div data-slot="team-diff" className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs max-sm:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        {label}
      </Button>
      {open ? (
        <ul
          aria-label={label}
          className="m-0 flex max-h-96 w-full list-none flex-col gap-0.5 overflow-auto p-0">
          {rows.map((row) => (
            <li
              key={row.key}
              data-to-auto={row.toAuto || undefined}
              className={cn(
                'flex items-start gap-1.5 rounded-sm px-1.5 py-0.5 text-xs break-words',
                row.toAuto && 'border-l-2 border-warning bg-warning/10',
              )}>
              <span
                aria-hidden="true"
                className="w-3 shrink-0 font-mono text-muted-foreground">
                {MARKER[row.marker].glyph}
              </span>
              <span className="min-w-0 flex-1">
                {rowText(row)}
                {row.detail !== null && !inline(row.detail) ? (
                  <ValueChange detail={row.detail} />
                ) : null}
                {row.toAuto ? (
                  <span className="ml-1 inline-flex items-center gap-0.5 font-medium text-warning">
                    <ShieldAlert aria-hidden="true" className="size-3" />
                    {RUNS_UNASKED_LABEL.toLowerCase()}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
