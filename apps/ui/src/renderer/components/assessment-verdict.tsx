import { cva } from 'class-variance-authority';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';

import { ErrorText } from './error-text';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { cn } from './ui/utils';

/** The user's verdict on an analysis's marks of one member. Twin of the daemon's `MEMBER_ASSESSMENT_USER_VERDICTS`. */
export interface AssessmentVerdictValue {
  verdict: 'agree' | 'disagree';
  note: string | null;
}

const toggle = cva(
  'inline-flex h-7 items-center gap-1 rounded-control border px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 [&>svg]:size-3.5',
  {
    variants: {
      on: {
        true: 'border-primary/40 bg-primary/10 text-primary',
        false:
          'border-border text-muted-foreground enabled:hover:text-foreground',
      },
    },
  },
);

/**
 * Whether the user agrees with an analysis's marks of a member, with a note
 * on a disagreement — what the next analysis reads as a correction. A press on
 * the chosen verdict clears it. Without `onChange` it only shows the verdict.
 */
export function AssessmentVerdict({
  value,
  onChange,
  className,
}: {
  value: AssessmentVerdictValue | null;
  onChange?: (next: AssessmentVerdictValue | null) => Promise<void>;
  className?: string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const save = (next: AssessmentVerdictValue | null): void => {
    if (onChange === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    onChange(next)
      .then(() => setDraft(null))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  };

  const agreed = value?.verdict === 'agree';
  const disagreed = value?.verdict === 'disagree';
  return (
    <div
      data-slot="assessment-verdict"
      data-verdict={value?.verdict ?? 'none'}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {onChange === undefined ? (
        value === null ? null : (
          <span className="text-xs text-muted-foreground">
            {agreed ? 'You agreed' : 'You disagreed'}
          </span>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Your verdict</span>
          <button
            type="button"
            aria-pressed={agreed}
            disabled={busy}
            className={toggle({ on: agreed })}
            onClick={() =>
              save(agreed ? null : { verdict: 'agree', note: null })
            }>
            <ThumbsUp aria-hidden="true" />
            Agree
          </button>
          <button
            type="button"
            aria-pressed={disagreed}
            disabled={busy}
            className={toggle({ on: disagreed })}
            onClick={() =>
              disagreed ? save(null) : setDraft(value?.note ?? '')
            }>
            <ThumbsDown aria-hidden="true" />
            Disagree
          </button>
        </div>
      )}
      {draft === null ? null : (
        <div className="flex flex-col gap-1.5">
          <Textarea
            aria-label="Why you disagree"
            placeholder="What the analysis got wrong — the next one reads this"
            value={draft}
            rows={2}
            className="min-h-0 text-xs"
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                save({ verdict: 'disagree', note: draft.trim() || null })
              }>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}
      {disagreed && value.note !== null && draft === null ? (
        <p className="m-0 text-xs break-words text-muted-foreground">
          “{value.note}”
        </p>
      ) : null}
      {error === null ? null : (
        <ErrorText className="text-xs">{error}</ErrorText>
      )}
    </div>
  );
}
