import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { cn } from '../components/ui/utils';
import { DiffView, editDiffOf } from './diff-view';

/** One parsed AskUserQuestion entry (defensive — bad shapes are dropped). */
interface ParsedQuestion {
  question: string;
  options: string[];
}

/** TWIN LIMIT: apps/daemon/src/v1/agents/chat.types.ts MAX_ANSWER_LENGTH. */
const MAX_ANSWER_LENGTH = 32_768;

/** How long "Sending…" holds before the one-shot freeze re-arms for a retry. */
const RESPONDED_RETRY_MS = 10_000;

function combinedAnswer(
  questions: ParsedQuestion[],
  answers: Record<number, string>,
): string {
  return questions
    .map((question, index) => `${question.question}: ${answers[index] ?? ''}`)
    .join('\n');
}

/**
 * Parse an AskUserQuestion tool input (`{ questions: [{ question, options:
 * [{ label }] }] }`) into renderable entries. Empty for any other tool's
 * input — the card then falls back to the plain approve/deny body.
 *
 * TWIN PARSER: the daemon parses the same wire shape in
 * apps/daemon/src/v1/agents/adapters/claude/question-payload.ts (no
 * daemon↔renderer shared package exists) — a shape drift fixed there must be
 * mirrored here, and vice versa. Mirrored rules: option labels are kept only
 * when non-empty and ≤ MAX_ANSWER_LENGTH.
 */
function readQuestions(input: unknown): ParsedQuestion[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  const parsed: ParsedQuestion[] = [];
  for (const entry of questions) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const q = entry as { question?: unknown; options?: unknown };
    if (typeof q.question !== 'string' || q.question.length === 0) {
      continue;
    }
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) =>
            o && typeof o === 'object'
              ? (o as { label?: unknown }).label
              : null,
          )
          .filter(
            (label): label is string =>
              typeof label === 'string' &&
              label.length > 0 &&
              label.length <= MAX_ANSWER_LENGTH,
          )
      : [];
    parsed.push({ question: q.question, options });
  }
  return parsed;
}

/**
 * Elicitation card for an `ask`-node's paused tool call. Live (no verdict
 * yet) it offers Approve/Deny; once the persisted `approval_verdict` item
 * arrives (or replays after reconnect) it renders the settled state — the
 * verdict item is the durable acknowledgment, so the card needs no local
 * optimistic state.
 *
 * An AskUserQuestion request renders as a QUESTION card instead: the
 * question text with its options as one-click answers plus a free-text
 * fallback — the picked answer rides the verdict (`answer`) and reaches the
 * agent as "The user responded: …" (the M4 escalation leg).
 */
export function ApprovalCard({
  toolName,
  input,
  verdict,
  expired = false,
  onRespond,
}: {
  toolName: string;
  input: unknown;
  /** null while pending; the user's answer once the verdict item arrived. */
  verdict: boolean | null;
  /** The turn ended before an answer — no verdict can apply anymore. */
  expired?: boolean;
  onRespond: (allow: boolean, answer?: string) => void;
}): React.JSX.Element {
  const [freeText, setFreeText] = useState('');
  const [selectedAnswers, setSelectedAnswers] = useState<
    Record<number, string>
  >({});
  // The verdict channel is one-shot: freeze the card the moment an answer is
  // sent, until the persisted verdict item (or expiry) round-trips — a
  // double-click or Approve-then-Deny would emit a conflicting verdict the
  // daemon silently drops.
  const [responded, setResponded] = useState(false);
  // The freeze must not be forever: if the verdict item never arrives (the
  // enqueued write failed, or the ack was 'invalid'), re-arm the buttons —
  // the daemon settles a request exactly once, so a retry is safe.
  useEffect(() => {
    if (!responded || verdict !== null || expired) {
      return;
    }
    const timer = setTimeout(() => setResponded(false), RESPONDED_RETRY_MS);
    return () => clearTimeout(timer);
  }, [responded, verdict, expired]);
  const respond = (allow: boolean, answer?: string): void => {
    if (responded) {
      return;
    }
    setResponded(true);
    // Preserve the caller-visible arity: a plain approve/deny stays a
    // one-argument call.
    if (answer === undefined) {
      onRespond(allow);
    } else {
      onRespond(allow, answer);
    }
  };
  const sending = responded && verdict === null && !expired;
  // Name-only, matching the daemon's fold gate exactly: a card must never
  // collect an answer the daemon would refuse to deliver (a flag-only
  // interactive tool renders the plain approve/deny body instead).
  const questions = toolName === 'AskUserQuestion' ? readQuestions(input) : [];
  const isMultiQuestion = questions.length > 1;
  const allQuestionsAnswered =
    isMultiQuestion &&
    questions.every((_, index) => Boolean(selectedAnswers[index]));
  const multiAnswer = combinedAnswer(questions, selectedAnswers);

  if (questions.length > 0) {
    return (
      <Card className="flex flex-col gap-2.5 border-primary/40 p-3">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion
            aria-hidden="true"
            className="size-4 shrink-0 text-primary"
          />
          <span className="text-sm font-medium">Agent asks a question</span>
        </div>
        {questions.map((q, qi) => (
          // Index-composite keys: one payload may repeat a question/label.
          <div key={`${qi}-${q.question}`} className="flex flex-col gap-1.5">
            <p className="m-0 text-sm whitespace-pre-wrap">{q.question}</p>
            {verdict === null && !expired && q.options.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {q.options.map((label, li) => (
                  <Button
                    key={`${li}-${label}`}
                    type="button"
                    variant={
                      isMultiQuestion && selectedAnswers[qi] === label
                        ? 'secondary'
                        : 'outline'
                    }
                    size="sm"
                    disabled={responded}
                    aria-pressed={
                      isMultiQuestion
                        ? selectedAnswers[qi] === label
                        : undefined
                    }
                    onClick={() => {
                      if (isMultiQuestion) {
                        setSelectedAnswers((previous) => ({
                          ...previous,
                          [qi]: label,
                        }));
                      } else {
                        respond(true, label);
                      }
                    }}>
                    {label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {expired && verdict === null ? (
          <p className="text-xs text-muted-foreground">
            ⏱ expired — the turn ended before an answer
          </p>
        ) : sending ? (
          <p className="text-xs text-muted-foreground">Sending…</p>
        ) : verdict === null ? (
          <div className="flex items-center gap-2">
            {questions.length === 1 ? (
              <>
                <Input
                  value={freeText}
                  maxLength={MAX_ANSWER_LENGTH}
                  aria-label="Answer the agent's question"
                  placeholder="Or type your own answer…"
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    // The verdict is one-shot — an Enter that merely confirms an
                    // IME composition must not submit a half-composed answer.
                    if (e.nativeEvent.isComposing) {
                      return;
                    }
                    if (e.key === 'Enter' && freeText.trim().length > 0) {
                      respond(true, freeText.trim());
                    }
                  }}
                />
                <Button
                  type="button"
                  disabled={freeText.trim().length === 0}
                  onClick={() => respond(true, freeText.trim())}>
                  Answer
                </Button>
              </>
            ) : (
              <Button
                type="button"
                disabled={
                  !allQuestionsAnswered ||
                  multiAnswer.length > MAX_ANSWER_LENGTH
                }
                onClick={() => respond(true, multiAnswer)}>
                Submit answers
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => respond(false)}>
              Decline
            </Button>
          </div>
        ) : (
          <p
            className={cn(
              'text-xs',
              verdict ? 'text-success' : 'text-destructive',
            )}>
            {verdict ? '✓ answered' : '✗ declined'}
          </p>
        )}
      </Card>
    );
  }

  // A file edit under review reads as a diff, not as raw JSON — the same
  // red/green view the tool-group rows use once the call has run.
  const diff = editDiffOf(toolName, input);
  const filePath =
    input && typeof input === 'object' && 'file_path' in input
      ? String((input as { file_path: unknown }).file_path)
      : null;
  let inputPreview: string;
  try {
    inputPreview = JSON.stringify(input, null, 2);
  } catch {
    inputPreview = String(input);
  }
  return (
    <Card className="flex flex-col gap-2.5 border-primary/40 p-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion
          aria-hidden="true"
          className="size-4 shrink-0 text-primary"
        />
        <span className="text-sm font-medium">Agent asks to run a tool</span>
        <Badge variant="secondary">{toolName}</Badge>
      </div>
      {diff ? (
        <div className="flex flex-col gap-1.5">
          {filePath ? (
            <div className="font-mono text-xs text-muted-foreground">
              {filePath}
            </div>
          ) : null}
          <div className="max-h-48 overflow-auto">
            <DiffView oldText={diff.oldText} newText={diff.newText} />
          </div>
        </div>
      ) : (
        <pre className="m-0 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {inputPreview}
        </pre>
      )}
      {expired && verdict === null ? (
        <p className="text-xs text-muted-foreground">
          ⏱ expired — the turn ended before an answer
        </p>
      ) : sending ? (
        <p className="text-xs text-muted-foreground">Sending…</p>
      ) : verdict === null ? (
        <div className="flex gap-2">
          <Button type="button" onClick={() => respond(true)}>
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => respond(false)}>
            Deny
          </Button>
        </div>
      ) : (
        <p
          className={cn(
            'text-xs',
            verdict ? 'text-success' : 'text-destructive',
          )}>
          {verdict ? '✓ approved' : '✗ denied'}
        </p>
      )}
    </Card>
  );
}
