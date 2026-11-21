import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../adapter.types';
import { ClaudeQuestionLeadIn } from './claude-question-lead-in.utils';

const QUESTION = 'Is this right?';
const ONE = { questions: [{ question: QUESTION, options: [] }] };
const ANSWERED = { ...ONE, answers: { [QUESTION]: 'Show me the picture' } };

const reasoning = (text: string): AgentEvent => ({ type: 'reasoning', text });
const askCall = (id = 't1'): AgentEvent => ({
  type: 'tool_call',
  id,
  name: 'AskUserQuestion',
  input: ONE,
});
const askRequest = (id = 'req-1'): AgentEvent => ({
  type: 'approval_request',
  id,
  toolName: 'AskUserQuestion',
  input: ONE,
});
const line = { type: 'assistant' };

function feed(leadIn: ClaudeQuestionLeadIn, ...events: AgentEvent[]): void {
  for (const event of events) {
    leadIn.observe(line, [event]);
  }
}

function answerOf(input: unknown): string {
  return (input as { answers: Record<string, string> }).answers[QUESTION]!;
}

describe('ClaudeQuestionLeadIn', () => {
  it('appends the summary that came right before the question to the answer', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(
      leadIn,
      reasoning('Here is the frame from the stand: the tag is yellow.\n\n'),
      askCall(),
      askRequest(),
    );

    const answer = answerOf(leadIn.withNotice('req-1', true, ANSWERED));

    expect(answer).toMatch(/^Show me the picture\n\n\(Geniro: /);
    expect(answer).toContain(
      'the user saw only this summary: «Here is the frame from the stand: the tag is yellow.»',
    );
    expect(answer).toContain('Any picture you put there was not shown');
    expect(answer).toContain("into the question text or an option's preview");
  });

  it('quotes every summary chunk since the last visible text or tool call', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(
      leadIn,
      reasoning('stale'),
      { type: 'text', text: 'Visible.' },
      reasoning('First.'),
      reasoning('Second.'),
      askCall(),
      askRequest(),
    );

    const answer = answerOf(leadIn.withNotice('req-1', true, ANSWERED));

    expect(answer).toContain('«First.\n\nSecond.»');
    expect(answer).not.toContain('stale');
  });

  it('folds the notice into `response` when several questions were answered at once', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, reasoning('Plan.'), askCall(), askRequest());

    const input = leadIn.withNotice('req-1', true, {
      ...ONE,
      response: 'A: yes\nB: no',
    }) as { response: string };

    expect(input.response).toMatch(/^A: yes\nB: no\n\n\(Geniro: /);
    expect(input.response).toContain('«Plan.»');
  });

  it('binds the summary when the permission request arrives before the tool call', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, reasoning('Plan.'), askRequest(), askCall());

    expect(answerOf(leadIn.withNotice('req-1', true, ANSWERED))).toContain(
      '«Plan.»',
    );
  });

  it.each([
    [600, `«${'x'.repeat(600)}»`],
    [601, `«${'x'.repeat(599)}…»`],
    [5000, `«${'x'.repeat(599)}…»`],
  ])('quotes a %i-character summary as %s', (length, quoted) => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, reasoning('x'.repeat(length)), askCall(), askRequest());

    const answer = answerOf(leadIn.withNotice('req-1', true, ANSWERED));

    expect(answer).toContain(quoted);
    expect(answer).not.toContain('x'.repeat(601));
  });

  it('answers once: a second verdict for the same request carries nothing', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, reasoning('Plan.'), askCall(), askRequest());
    leadIn.withNotice('req-1', true, ANSWERED);

    expect(leadIn.withNotice('req-1', true, ANSWERED)).toBe(ANSWERED);
  });

  it.each<[string, AgentEvent[]]>([
    ['no summary came before it', [askCall(), askRequest()]],
    [
      'visible text came between',
      [
        reasoning('Plan.'),
        { type: 'text', text: 'Said aloud.' },
        askCall(),
        askRequest(),
      ],
    ],
    [
      'another tool call came between',
      [
        reasoning('Plan.'),
        { type: 'tool_call', id: 'b', name: 'Bash', input: {} },
        askCall(),
        askRequest(),
      ],
    ],
    [
      'the summary belongs to a sub-agent',
      [
        {
          type: 'reasoning',
          text: 'Delegate plan.',
          parentToolUseId: 'task-1',
        },
        askCall(),
        askRequest(),
      ],
    ],
  ])('leaves the answer alone when %s', (_label, events) => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, ...events);

    expect(leadIn.withNotice('req-1', true, ANSWERED)).toBe(ANSWERED);
  });

  it('ignores a whole line a sub-agent wrote', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    leadIn.observe({ type: 'assistant', parent_tool_use_id: 'task-1' }, [
      reasoning('Delegate plan.'),
    ]);
    feed(leadIn, askCall(), askRequest());

    expect(leadIn.withNotice('req-1', true, ANSWERED)).toBe(ANSWERED);
  });

  it('leaves a denial and a permission request for another tool alone', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, reasoning('Plan.'), askCall(), askRequest());
    expect(leadIn.withNotice('req-1', false, ONE)).toBe(ONE);

    const other = new ClaudeQuestionLeadIn();
    feed(other, reasoning('Plan.'), {
      type: 'approval_request',
      id: 'req-2',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    const bash = { command: 'ls' };
    expect(other.withNotice('req-2', true, bash)).toBe(bash);
  });

  it('leaves an allow that carries no answer alone', () => {
    const leadIn = new ClaudeQuestionLeadIn();
    feed(leadIn, reasoning('Plan.'), askCall(), askRequest());

    expect(leadIn.withNotice('req-1', true, ONE)).toBe(ONE);
  });
});
