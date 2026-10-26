import { ShieldAlert } from 'lucide-react';
import { memo } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { RUNS_UNASKED_LABEL } from '../workflows/node-schema';
import { useThreadFlag } from './thread-ui-memory';
import type { DiffMarker, DiffRow } from './workflow-proposal-payload';

const MARKER: Record<DiffMarker, { glyph: string; word: string }> = {
  changed: { glyph: '~', word: 'changed' },
  added: { glyph: '+', word: 'added' },
  removed: { glyph: '−', word: 'removed' },
};

/** One change, in words — the marker glyph is decoration beside them. */
function rowText(row: DiffRow): string {
  switch (row.scope) {
    case 'workflow':
      return `workflow ${row.subject} changed`;
    case 'wire':
      return `wire ${row.subject} ${MARKER[row.marker].word}`;
    case 'node':
      return row.detail === null
        ? `${row.subject} ${MARKER[row.marker].word}`
        : `${row.subject} · ${row.detail.field}: ${row.detail.before} → ${row.detail.after}`;
  }
}

/**
 * What a replacement changes against the saved workflow, one line per change,
 * every change that makes an agent run tools unasked first and tinted — the
 * ones a reader skimming the list must still see.
 *
 * Folds, open by default, remembered per thread under `memoryKey`.
 */
export const WorkflowDiffList = memo(function WorkflowDiffList({
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
      <p
        data-slot="workflow-diff"
        className="m-0 text-xs text-muted-foreground">
        Identical to the saved workflow
      </p>
    );
  }
  const label = `${rows.length} ${rows.length === 1 ? 'change' : 'changes'}`;
  return (
    <div data-slot="workflow-diff" className="flex flex-col items-start gap-1">
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
          className="m-0 flex max-h-48 w-full list-none flex-col gap-0.5 overflow-auto p-0">
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
