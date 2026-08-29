import { ListChecks } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../components/ui/utils';
import { useOneShotVerdict } from './use-one-shot-verdict';

/**
 * geniro's OWN plan-proposal tool.
 *
 * TWIN: `HOST_PLAN_TOOL` in `apps/daemon/src/v1/agents/chat.types.ts`. A bare
 * literal for the reason `PROPOSE_PATCH` next door is one — nothing generated
 * spans this seam, because the name reaches the renderer inside an
 * `approval_request` payload, which is `z.unknown()` on the wire by design.
 */
export const PROPOSE_PLAN = 'propose_plan';

/**
 * TWIN LIMIT: `MAX_ANSWER_LENGTH` in the daemon's chat types — the note rides
 * the same `answer` field a question's does, so it is bounded by the same cap.
 * Enforced here rather than only counted: the send would be refused at the
 * daemon edge, and a card that let the user type past it would lose their words
 * to a failure they were given no warning about.
 */
const MAX_NOTE_LENGTH = 32_768;

/** One parsed step of a proposed plan. */
export interface ParsedPlanStep {
  title: string;
  detail: string | null;
}

/** A parsed plan, or null when the payload is not one. */
export interface ParsedPlan {
  title: string;
  steps: ParsedPlanStep[];
}

/**
 * Read a `propose_plan` request's input.
 *
 * The TWIN-PARSER convention: the daemon wrote this payload through
 * `readHostPlan`, and this reads it back independently rather than through a
 * generated type, because the item payload is untyped on the wire. So it is
 * written defensively even though the daemon has already validated — the two
 * are twins, not one function called twice, and a payload replayed from a
 * transcript an older daemon wrote must not crash the renderer.
 *
 * Null when nothing readable is there, which is what routes the card back to
 * the plain permission body rather than drawing an empty plan.
 */
export function readPlan(input: unknown): ParsedPlan | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as { title?: unknown; steps?: unknown };
  if (typeof record.title !== 'string' || record.title.length === 0) {
    return null;
  }
  if (!Array.isArray(record.steps)) {
    return null;
  }
  const steps: ParsedPlanStep[] = [];
  for (const entry of record.steps) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const step = entry as { title?: unknown; detail?: unknown };
    if (typeof step.title !== 'string' || step.title.length === 0) {
      continue;
    }
    steps.push({
      title: step.title,
      detail:
        typeof step.detail === 'string' && step.detail.length > 0
          ? step.detail
          : null,
    });
  }
  return steps.length > 0 ? { title: record.title, steps } : null;
}

/**
 * A plan the agent proposes before doing the work: the steps, Approve/Reject,
 * and a note the user may send with either.
 *
 * The note is the part that earns this card over a prose plan in the
 * transcript. A bare "no" costs a round trip — the agent replies asking what
 * the user would rather have, and only then hears it — while "no: leave the
 * parser alone" redirects it in the same press. It is optional on purpose:
 * Approve with nothing typed is the common case and must stay one click.
 *
 * Once settled the card keeps the plan on screen with the verdict against it,
 * because a plan is what the rest of the conversation refers back to.
 */
export function PlanCard({
  plan,
  verdict,
  note = null,
  expired,
  onRespond,
}: {
  plan: ParsedPlan;
  /** null while pending; the user's decision once the verdict item arrived. */
  verdict: boolean | null;
  /** The words that decision carried, read back from the same verdict item. */
  note?: string | null;
  /** The turn ended before an answer — no verdict can apply anymore. */
  expired: boolean;
  onRespond: (allow: boolean, answer?: string) => void;
}): React.JSX.Element {
  const { sending, respond } = useOneShotVerdict(verdict, expired, onRespond);
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_NOTE_LENGTH;
  const send = (allow: boolean): void => {
    if (tooLong) {
      return;
    }
    // Arity preserved: a plan answered with nothing typed sends the same
    // one-argument verdict every other permission card sends, so the daemon's
    // note branch is never entered with an empty string.
    if (trimmed.length === 0) {
      respond(allow);
    } else {
      respond(allow, trimmed);
    }
  };
  return (
    <Card className="flex flex-col gap-2.5 border-primary/40 p-3">
      <div className="flex items-center gap-2">
        <ListChecks
          aria-hidden="true"
          className="size-4 shrink-0 text-primary"
        />
        <span className="min-w-0 flex-1 text-sm font-medium">{plan.title}</span>
      </div>
      {/* An ordered list, and semantically so: the order IS the plan, and a
          screen reader announcing "list of 4" over unordered rows would lose
          it. The numbers are drawn rather than left to the marker so they line
          up with the text of a step that wraps. */}
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {plan.steps.map((step, index) => (
          <li key={index} className="flex gap-2">
            <span
              aria-hidden="true"
              className="w-5 shrink-0 text-right font-mono text-xs leading-5 text-muted-foreground">
              {index + 1}.
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm leading-5 break-words">
                {step.title}
              </span>
              {step.detail === null ? null : (
                <span className="text-xs leading-5 text-muted-foreground break-words">
                  {step.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {expired && verdict === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          ⏱ expired — the turn ended before an answer
        </p>
      ) : sending ? (
        <p className="m-0 text-xs text-muted-foreground">Sending…</p>
      ) : verdict === null ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            className="min-h-0 text-sm"
            aria-label="Note to the agent"
            placeholder="Optional — anything to change, or to keep in mind"
          />
          {tooLong ? (
            <p className="m-0 text-xs text-destructive">
              That note is too long to send.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" onClick={() => send(true)} disabled={tooLong}>
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => send(false)}
              disabled={tooLong}>
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p
            className={cn(
              'm-0 text-xs',
              verdict ? 'text-success' : 'text-destructive',
            )}>
            {verdict ? '✓ approved' : '✗ rejected'}
          </p>
          {/* The note is shown back for the reason the question card shows an
              answer: it went to the agent, so what the agent is working from
              has to be readable in the transcript rather than only in the box
              it was typed into. */}
          {note !== null && note.trim() !== '' ? (
            <p className="m-0 max-h-40 overflow-auto rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap">
              {note}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
