import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';

/** One parsed AskUserQuestion entry (defensive — bad shapes are dropped). */
interface ParsedQuestion {
  question: string;
  options: string[];
}

/**
 * Parse an AskUserQuestion tool input (`{ questions: [{ question, options:
 * [{ label }] }] }`) into renderable entries. Empty for any other tool's
 * input — the card then falls back to the plain approve/deny body.
 *
 * TWIN PARSER: the daemon parses the same wire shape in
 * apps/daemon/src/v1/agents/adapters/claude/question-payload.ts (no
 * daemon↔renderer shared package exists) — a shape drift fixed there must be
 * mirrored here, and vice versa.
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
          .filter((label): label is string => typeof label === 'string')
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
  // Name-only, matching the daemon's fold gate exactly: a card must never
  // collect an answer the daemon would refuse to deliver (a flag-only
  // interactive tool renders the plain approve/deny body instead).
  const questions = toolName === 'AskUserQuestion' ? readQuestions(input) : [];

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
                    variant="outline"
                    size="sm"
                    onClick={() => onRespond(true, label)}>
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
        ) : verdict === null ? (
          <div className="flex items-center gap-2">
            <Input
              value={freeText}
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
                  onRespond(true, freeText.trim());
                }
              }}
            />
            <Button
              type="button"
              disabled={freeText.trim().length === 0}
              onClick={() => onRespond(true, freeText.trim())}>
              Answer
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onRespond(false)}>
              Decline
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {verdict ? '✓ answered' : '✗ declined'}
          </p>
        )}
      </Card>
    );
  }

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
      <pre className="m-0 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {inputPreview}
      </pre>
      {expired && verdict === null ? (
        <p className="text-xs text-muted-foreground">
          ⏱ expired — the turn ended before an answer
        </p>
      ) : verdict === null ? (
        <div className="flex gap-2">
          <Button type="button" onClick={() => onRespond(true)}>
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onRespond(false)}>
            Deny
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {verdict ? '✓ approved' : '✗ denied'}
        </p>
      )}
    </Card>
  );
}
