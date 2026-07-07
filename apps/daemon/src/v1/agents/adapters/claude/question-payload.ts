/**
 * Projections over claude's AskUserQuestion tool input (the probe-verified
 * shape:
 * `{ questions: [{ question, header, options: [{ label, … }], multiSelect }] }`)
 * for the M4 Q&A bridge. Defensive throughout — a malformed or
 * version-drifted payload degrades to empty projections, never a throw
 * (the raw payload still reaches the transcript row untouched).
 *
 * TWIN PARSER: the renderer's question card re-implements this parse over the
 * same wire shape (apps/ui/src/renderer/chats/approval-card.tsx
 * `readQuestions`) because no daemon↔renderer shared package exists — a shape
 * drift fixed here must be mirrored there, and vice versa.
 */

interface QuestionShape {
  question: string;
  options: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readQuestions(input: unknown): QuestionShape[] {
  const root = asRecord(input);
  if (!root || !Array.isArray(root.questions)) {
    return [];
  }
  const shapes: QuestionShape[] = [];
  for (const entry of root.questions) {
    const q = asRecord(entry);
    const text = typeof q?.question === 'string' ? q.question : null;
    if (!q || !text) {
      continue;
    }
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) => asRecord(o)?.label)
          .filter((label): label is string => typeof label === 'string')
      : [];
    shapes.push({ question: text, options });
  }
  return shapes;
}

/** The question text for the caller's envelope (multi-question joins lines). */
export function questionTextOf(input: unknown): string {
  return readQuestions(input)
    .map((q) => q.question)
    .join('\n');
}

/** Every option label the callee offered, across all questions. */
export function optionLabelsOf(input: unknown): string[] {
  return readQuestions(input).flatMap((q) => q.options);
}

/**
 * The caller's (or user's) free-text answer folded into the tool input as the
 * `response` field — claude's AskUserQuestion surfaces it to the model as
 * "The user responded: <text>" (probe-verified on 2.1.202).
 */
export function withResponse(input: unknown, answer: string): unknown {
  const root = asRecord(input);
  return root ? { ...root, response: answer } : { response: answer };
}
