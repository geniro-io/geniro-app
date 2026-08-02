import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { cn } from '../components/ui/utils';
import { DiffView, editDiffOf } from './diff-view';

/** One parsed AskUserQuestion entry (defensive — bad shapes are dropped). */
interface ParsedQuestion {
  question: string;
  /** The CLI's short tab title for this question; null when it sent none. */
  header: string | null;
  options: string[];
  multiSelect: boolean;
}

/** TWIN LIMIT: apps/daemon/src/v1/agents/chat.types.ts MAX_ANSWER_LENGTH. */
const MAX_ANSWER_LENGTH = 32_768;

/**
 * TWIN LIMIT: apps/daemon/src/v1/agents/chat.types.ts
 * MAX_QUESTION_HEADER_LENGTH. A header is rendered as a tab title, and the tab
 * strip has no truncation of its own.
 */
const MAX_QUESTION_HEADER_LENGTH = 64;

/** How long "Sending…" holds before the one-shot freeze re-arms for a retry. */
const RESPONDED_RETRY_MS = 10_000;

/** The tab title for one question — its header, or its position as a fallback. */
function tabLabel(question: ParsedQuestion, index: number): string {
  return question.header ?? `Question ${index + 1}`;
}

/**
 * How much of a question's own text may prefix its answer in the submission.
 * The question is AGENT-written and unbounded, while the submission it rides in
 * is capped at MAX_ANSWER_LENGTH — so without this an over-long question would
 * spend the budget the user's answer needs and kill Submit before a character
 * was typed. It only shortens the LABEL; the question renders in full above.
 */
const MAX_ANSWER_LABEL_LENGTH = 80;

function answerLabel(question: ParsedQuestion): string {
  return question.question.length <= MAX_ANSWER_LABEL_LENGTH
    ? question.question
    : `${question.question.slice(0, MAX_ANSWER_LABEL_LENGTH - 1)}…`;
}

/**
 * Join one tab's answer parts. The ONE rule for it, shared by the staged path
 * and the answer-on-click path — which disagreed until an adversarial test
 * caught the click path silently dropping a typed qualifier.
 */
function joinParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(', ');
}

/**
 * The multi-question submission: one labelled line per question, so the single
 * `response` wire channel stays unambiguous about which answer belongs where.
 */
function combinedAnswer(
  questions: ParsedQuestion[],
  answerAt: (index: number) => string,
): string {
  return questions
    .map((question, index) => `${answerLabel(question)}: ${answerAt(index)}`)
    .join('\n');
}

/**
 * Parse an AskUserQuestion tool input (`{ questions: [{ question, options:
 * [{ label }] }] }`) into renderable entries. Empty for any other tool's
 * input — the card then falls back to the plain approve/deny body.
 *
 * TWIN PARSER: the daemon parses the same wire shape in
 * apps/daemon/src/v1/agents/adapters/claude/utils/claude-question.utils.ts (no
 * daemon↔renderer shared package exists) — a shape drift fixed there must be
 * mirrored here, and vice versa. Mirrored rules: option labels are kept only
 * when non-empty and ≤ MAX_ANSWER_LENGTH; `header` only when non-empty and
 * ≤ MAX_QUESTION_HEADER_LENGTH; `multiSelect` only when the payload says so
 * literally (a truthy string would let one side offer multi-pick while the
 * other offers one).
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
    const q = entry as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
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
    parsed.push({
      question: q.question,
      header:
        typeof q.header === 'string' &&
        q.header.length > 0 &&
        q.header.length <= MAX_QUESTION_HEADER_LENGTH
          ? q.header
          : null,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return parsed;
}

/**
 * The one-shot verdict channel both card bodies share.
 *
 * Freeze the card the moment an answer is sent, until the persisted verdict
 * item (or expiry) round-trips — a double-click, or Approve-then-Deny, would
 * emit a conflicting verdict the daemon silently drops. The freeze must not be
 * forever though: if the verdict item never arrives (its write failed, or the
 * ack was 'invalid') the controls re-arm, because the daemon settles a request
 * exactly once and a retry is therefore safe.
 *
 * Shared rather than written twice: the question card and the permission card
 * are separate components with the same contract, and a fix to this timing on
 * one of them has to reach both.
 */
function useOneShotVerdict(
  verdict: boolean | null,
  expired: boolean,
  onRespond: (allow: boolean, answer?: string) => void,
): {
  responded: boolean;
  sending: boolean;
  respond: (allow: boolean, answer?: string) => void;
} {
  const [responded, setResponded] = useState(false);
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
  return {
    responded,
    sending: responded && verdict === null && !expired,
    respond,
  };
}

/**
 * An AskUserQuestion request: one TAB per question, each returnable and
 * re-answerable, with the picked answer riding the verdict (`answer`) to reach
 * the agent as "The user responded: …" (the M4 escalation leg).
 *
 * Rendered only for a payload that actually parsed into questions — the router
 * below falls back to the plain permission body otherwise.
 */
function QuestionCard({
  questions,
  verdict,
  expired,
  onRespond,
}: {
  /** Already parsed and non-empty. */
  questions: ParsedQuestion[];
  verdict: boolean | null;
  expired: boolean;
  onRespond: (allow: boolean, answer?: string) => void;
}): React.JSX.Element {
  // Per question, kept independently so every tab stays returnable: switching
  // away and back must show the same picks and the same typed text, and both
  // must remain changeable until the one submission is sent.
  const [activeTab, setActiveTab] = useState(0);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [texts, setTexts] = useState<Record<number, string>>({});
  const cardId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const { responded, sending, respond } = useOneShotVerdict(
    verdict,
    expired,
    onRespond,
  );
  const pending = verdict === null && !expired;
  // One tab per question, and only while the card can still be answered —
  // a settled card is a transcript row, so it lists every question instead.
  const showTabs = pending && questions.length > 1;
  const activeIndex = Math.min(activeTab, questions.length - 1);
  const active = questions[activeIndex]!;
  // A click can only BE the whole answer when there is exactly one question
  // and it takes exactly one pick; otherwise picks stage until Submit —
  // which is also what makes each of them re-answerable.
  const staged = questions.length > 1 || questions[0]!.multiSelect;
  // Each tab's answer: the labels it picked, plus whatever was typed there.
  // Both, so "Red, but a lighter shade" survives as one answer.
  const answerAt = (index: number): string =>
    joinParts([...(picked[index] ?? []), (texts[index] ?? '').trim()]);
  const submission =
    questions.length > 1 ? combinedAnswer(questions, answerAt) : answerAt(0);
  // The per-tab budget: the daemon drops an oversized verdict on the floor
  // (notifications.gateway `readVerdict`), so the tabs share the one wire
  // limit rather than letting any single tab spend all of it. The labelled
  // prefixes are reserved out of it first, so filling every tab to its own
  // maxLength always yields a submission the daemon will accept.
  const prefixCost =
    questions.length > 1
      ? questions.reduce(
          // `: ` after the label, `\n` between lines.
          (total, question) => total + answerLabel(question).length + 3,
          0,
        )
      : 0;
  const perTabBudget = Math.max(
    1,
    Math.floor((MAX_ANSWER_LENGTH - prefixCost) / questions.length),
  );
  // What is left of THIS tab's share once its picked labels are counted. The
  // answer that travels is picks + typed text joined, so bounding only the
  // typed half would let a pick push the tab past its budget — and the user
  // would hit the refusal by typing inside a limit the field itself allowed.
  const chosen = picked[activeIndex] ?? [];
  // On the staged path the picks are already made, so charge exactly them.
  // On the answer-on-click path NOTHING is picked yet and a click is the
  // submit — so reserve room for the WIDEST label this tab could add, or a
  // full-length typed answer plus a click would exceed the wire limit on a
  // path that has no Submit button to disable.
  const pendingPickCost = staged
    ? chosen.length === 0
      ? 0
      : joinParts(chosen).length + 2
    : active.options.reduce(
        (widest, label) => Math.max(widest, label.length),
        0,
      ) + 2;
  // Floored at 0, not 1: an option label wide enough to consume the whole
  // budget must leave NO room to type, or the click path — the one submit
  // path with no gate in front of it — sends label + text past the wire
  // limit and the daemon drops it with no on-card explanation.
  const typedBudget = Math.max(0, perTabBudget - pendingPickCost);
  const unanswered = questions
    .map((q, index) =>
      answerAt(index).length === 0 ? tabLabel(q, index) : null,
    )
    .filter((label): label is string => label !== null);
  const tooLong = submission.length > MAX_ANSWER_LENGTH;
  // ONE gate, shared by the Submit button and the Enter key — two conditions
  // would drift, and an Enter that outran the button's guard would send an
  // answer the daemon drops on the floor with no on-card explanation.
  const canSubmit = unanswered.length === 0 && !tooLong;
  // Submit is disabled for exactly two reasons, and both are SAID: a
  // disabled button with no explanation is the defect this card had.
  const blockedReason = tooLong
    ? `That answer is ${submission.length.toLocaleString()} characters — ${MAX_ANSWER_LENGTH.toLocaleString()} is the most the agent can receive. Shorten one of the answers.`
    : unanswered.length === 0
      ? null
      : questions.length > 1
        ? `Answer every tab to submit — still empty: ${unanswered.join(', ')}.`
        : 'Pick an option or type an answer to submit.';
  const pickOption = (index: number, label: string): void => {
    if (!staged) {
      // The click IS the whole answer here — but it is not the whole answer
      // TEXT: a qualifier already typed beside the options rides with it,
      // through the same join the staged path uses. Dropping it would spend
      // the one-shot verdict on a partial answer the user can't resend.
      respond(true, joinParts([label, (texts[index] ?? '').trim()]));
      return;
    }
    setPicked((previous) => {
      const current = previous[index] ?? [];
      if (!questions[index]!.multiSelect) {
        // Single-pick: clicking the chosen label again clears it, so a
        // mis-tap is recoverable without spending the one-shot verdict.
        return { ...previous, [index]: current[0] === label ? [] : [label] };
      }
      return {
        ...previous,
        [index]: current.includes(label)
          ? current.filter((chosen) => chosen !== label)
          : [...current, label],
      };
    });
  };
  const focusTab = (index: number): void => {
    const next = (index + questions.length) % questions.length;
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };
  return (
    <Card className="flex flex-col gap-2.5 border-primary/40 p-3">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion
          aria-hidden="true"
          className="size-4 shrink-0 text-primary"
        />
        <span className="text-sm font-medium">Agent asks a question</span>
        {questions.length === 1 && active.header ? (
          <Badge variant="secondary">{active.header}</Badge>
        ) : null}
      </div>
      {showTabs ? (
        <div
          role="tablist"
          aria-label="Questions"
          className="flex flex-wrap gap-1 border-b border-border pb-1.5">
          {questions.map((q, qi) => {
            const selected = qi === activeIndex;
            const answered = answerAt(qi).length > 0;
            return (
              // Index-composite keys: one payload may repeat a question.
              <button
                key={`${qi}-${q.question}`}
                ref={(node) => {
                  tabRefs.current[qi] = node;
                }}
                type="button"
                role="tab"
                id={`${cardId}-tab-${qi}`}
                aria-selected={selected}
                aria-controls={`${cardId}-panel-${qi}`}
                // Roving tabindex: the strip is ONE tab stop, arrows move
                // within it — the pattern `role="tab"` promises.
                tabIndex={selected ? 0 : -1}
                data-answered={answered}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    focusTab(activeIndex + 1);
                  } else if (e.key === 'ArrowLeft') {
                    focusTab(activeIndex - 1);
                  } else if (e.key === 'Home') {
                    focusTab(0);
                  } else if (e.key === 'End') {
                    focusTab(questions.length - 1);
                  } else {
                    return;
                  }
                  e.preventDefault();
                }}
                onClick={() => setActiveTab(qi)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selected
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}>
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 rounded-full',
                    answered ? 'bg-primary' : 'bg-border',
                  )}
                />
                {tabLabel(q, qi)}
              </button>
            );
          })}
        </div>
      ) : null}
      {pending ? (
        <div
          role={showTabs ? 'tabpanel' : undefined}
          id={showTabs ? `${cardId}-panel-${activeIndex}` : undefined}
          aria-labelledby={
            showTabs ? `${cardId}-tab-${activeIndex}` : undefined
          }
          className="flex flex-col gap-1.5">
          <p className="m-0 text-sm whitespace-pre-wrap">{active.question}</p>
          {active.multiSelect ? (
            <p className="m-0 text-xs text-muted-foreground">
              Pick as many as apply.
            </p>
          ) : null}
          {active.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {active.options.map((label, li) => {
                const chosen = (picked[activeIndex] ?? []).includes(label);
                return (
                  <Button
                    key={`${li}-${label}`}
                    type="button"
                    variant={staged && chosen ? 'secondary' : 'outline'}
                    size="sm"
                    disabled={responded}
                    aria-pressed={staged ? chosen : undefined}
                    onClick={() => pickOption(activeIndex, label)}>
                    {label}
                  </Button>
                );
              })}
            </div>
          ) : null}
          {/* On EVERY tab, not just a lone question: it is the only way to
              answer one the agent offered no options for, and the only way
              to qualify a pick. */}
          <Input
            value={texts[activeIndex] ?? ''}
            maxLength={typedBudget}
            disabled={responded}
            aria-label={
              questions.length > 1
                ? `Answer: ${tabLabel(active, activeIndex)}`
                : "Answer the agent's question"
            }
            placeholder={
              active.options.length > 0
                ? 'Or type your own answer…'
                : 'Type your answer…'
            }
            onChange={(e) =>
              setTexts((previous) => ({
                ...previous,
                [activeIndex]: e.target.value,
              }))
            }
            onKeyDown={(e) => {
              // The verdict is one-shot — an Enter that merely confirms an
              // IME composition must not submit a half-composed answer.
              if (e.nativeEvent.isComposing) {
                return;
              }
              // Only when this tab IS the whole answer; with more to fill in,
              // Enter would submit the others empty.
              if (e.key === 'Enter' && !staged && canSubmit) {
                respond(true, submission);
              }
            }}
          />
        </div>
      ) : (
        questions.map((q, qi) => (
          <p
            key={`${qi}-${q.question}`}
            className="m-0 text-sm whitespace-pre-wrap">
            {q.question}
          </p>
        ))
      )}
      {expired && verdict === null ? (
        <p className="text-xs text-muted-foreground">
          ⏱ expired — the turn ended before an answer
        </p>
      ) : sending ? (
        <p className="text-xs text-muted-foreground">Sending…</p>
      ) : verdict === null ? (
        <>
          {blockedReason ? (
            <p className="m-0 text-xs text-warning">{blockedReason}</p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => respond(true, submission)}>
              {staged ? 'Submit answers' : 'Answer'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => respond(false)}>
              Decline
            </Button>
          </div>
        </>
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

/**
 * A paused tool call under review: Approve/Deny over the tool's input, with a
 * file edit rendered as the same red/green diff the tool-group rows use.
 */
function PermissionCard({
  toolName,
  input,
  verdict,
  expired,
  onRespond,
}: {
  toolName: string;
  input: unknown;
  verdict: boolean | null;
  expired: boolean;
  onRespond: (allow: boolean, answer?: string) => void;
}): React.JSX.Element {
  const { sending, respond } = useOneShotVerdict(verdict, expired, onRespond);
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

/**
 * Elicitation card for an `ask`-node's paused tool call — a two-line router.
 *
 * Once the persisted `approval_verdict` item arrives (or replays after a
 * reconnect) each body renders its settled state; the verdict item is the
 * durable acknowledgment, so neither needs local optimistic state.
 *
 * The AskUserQuestion split is NAME-ONLY, matching the daemon's answer-fold
 * gate exactly: a card must never collect an answer the daemon would refuse to
 * deliver, so a flag-only interactive tool renders the permission body — as
 * does an AskUserQuestion whose payload parses to nothing.
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
  const questions = toolName === 'AskUserQuestion' ? readQuestions(input) : [];
  return questions.length > 0 ? (
    <QuestionCard
      questions={questions}
      verdict={verdict}
      expired={expired}
      onRespond={onRespond}
    />
  ) : (
    <PermissionCard
      toolName={toolName}
      input={input}
      verdict={verdict}
      expired={expired}
      onRespond={onRespond}
    />
  );
}
