import { describe, expect, it } from 'vitest';

import {
  HOST_QUESTION_TOOL,
  MAX_HOST_QUESTION_OPTIONS,
  MAX_HOST_QUESTIONS,
  MAX_QUESTION_HEADER_LENGTH,
} from '../chat.types';
import {
  deferredAnswerMessage,
  hostMcpServerName,
  hostQuestionResultText,
  isHostQuestionCall,
  readHostQuestions,
} from './host-question';

describe('readHostQuestions', () => {
  it('reads a well-formed call', () => {
    expect(
      readHostQuestions({
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            multiSelect: true,
            options: [
              { label: 'Postgres', description: 'What we run in prod' },
              { label: 'SQLite' },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        question: 'Which database?',
        header: 'DB',
        multiSelect: true,
        options: [
          { label: 'Postgres', description: 'What we run in prod' },
          { label: 'SQLite' },
        ],
      },
    ]);
  });

  it('accepts a bare string option, which is what a model reaches for first', () => {
    const [question] = readHostQuestions({
      questions: [{ question: 'Ship it?', options: ['Yes', 'No'] }],
    });
    expect(question?.options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
  });

  it('drops a question with no options — the card would have nothing to press', () => {
    expect(
      readHostQuestions({
        questions: [
          { question: 'Anything?', options: [] },
          { question: 'Anything?', options: [{ label: '   ' }] },
          { question: 'Real?', options: [{ label: 'Yes' }] },
        ],
      }).map((q) => q.question),
    ).toEqual(['Real?']);
  });

  it('answers nothing for a shape it cannot read, rather than throwing across the transport', () => {
    expect(readHostQuestions({})).toEqual([]);
    expect(readHostQuestions({ questions: 'ask me' })).toEqual([]);
    expect(
      readHostQuestions({ questions: [null, 7, { question: '' }] }),
    ).toEqual([]);
  });

  it('truncates past the caps instead of refusing a real question', () => {
    const parsed = readHostQuestions({
      questions: Array.from({ length: MAX_HOST_QUESTIONS + 3 }, (_, i) => ({
        question: `Q${i}`,
        options: Array.from(
          { length: MAX_HOST_QUESTION_OPTIONS + 4 },
          (_, j) => ({ label: `O${j}` }),
        ),
      })),
    });
    expect(parsed).toHaveLength(MAX_HOST_QUESTIONS);
    expect(parsed[0]?.options).toHaveLength(MAX_HOST_QUESTION_OPTIONS);
  });

  it('drops an over-long header rather than letting it push the controls off the card', () => {
    const [question] = readHostQuestions({
      questions: [
        {
          question: 'Which?',
          header: 'h'.repeat(MAX_QUESTION_HEADER_LENGTH + 1),
          options: [{ label: 'Yes' }],
        },
      ],
    });
    expect(question?.header).toBeUndefined();
  });
});

describe('isHostQuestionCall', () => {
  const server = hostMcpServerName('75a31aea-0000-0000-0000-000000000000');

  it('recognises the CLI’s own prose rendering of server + tool', () => {
    // Measured on cursor-agent 2026.08.11-e8db854 in the running app: this is
    // the whole `toolName` a permission request for the tool arrives under.
    expect(
      isHostQuestionCall(
        server,
        'geniro-75a31aea-ask_user_question: ask_user_question',
      ),
    ).toBe(true);
  });

  it('recognises the bare tool name', () => {
    expect(isHostQuestionCall(server, HOST_QUESTION_TOOL)).toBe(true);
  });

  it('refuses a user’s own server, however it is named', () => {
    expect(isHostQuestionCall(server, 'linear: create_issue')).toBe(false);
    // Both halves are required: a server that merely publishes a tool of the
    // same name is not geniro's, and the run id in the server name is what
    // makes that unforgeable.
    expect(isHostQuestionCall(server, 'somebody-else: ask_user_question')).toBe(
      false,
    );
    expect(isHostQuestionCall(server, `${server}: run_shell`)).toBe(false);
  });

  it('refuses everything when this CLI was handed no server at all', () => {
    expect(isHostQuestionCall(null, HOST_QUESTION_TOOL)).toBe(false);
    // Including the SERVER-QUALIFIED spelling. A null server means this turn
    // registered no such tool — which is every claude chat, since that CLI has
    // its own — so a request naming it is not geniro's to approve, however it
    // is spelled.
    expect(
      isHostQuestionCall(null, `mcp__${server}__${HOST_QUESTION_TOOL}`),
    ).toBe(false);
  });
});

describe('hostQuestionResultText', () => {
  it('tells the three outcomes apart, so a refusal never reads as an answer', () => {
    const answered = hostQuestionResultText({
      status: 'answered',
      answer: 'Postgres',
    });
    const declined = hostQuestionResultText({ status: 'declined' });
    const unavailable = hostQuestionResultText({
      status: 'unavailable',
      reason: 'the turn ended',
    });
    expect(answered).toContain('Postgres');
    expect(declined).not.toBe(answered);
    expect(unavailable).not.toBe(declined);
    expect(declined).toMatch(/dismissed/i);
    expect(unavailable).toContain('the turn ended');
  });
});

describe('the deferred arm', () => {
  it('tells the agent to stop and wait rather than to ask again', () => {
    const posted = hostQuestionResultText({ status: 'posted' });

    // Every clause answers a way the turn went wrong before it existed: the
    // model carrying on and guessing, the model re-asking (which raises no new
    // card and only spends a turn), and the model failing to recognise its next
    // user message as the reply.
    expect(posted).toMatch(/stop/i);
    expect(posted).toMatch(/again/i);
    expect(posted).toMatch(/next user message/i);
    // It is not an ending, so it must not read like the other three.
    expect(posted).not.toBe(hostQuestionResultText({ status: 'declined' }));
  });

  it('sends the answer verbatim and marks what is NOT the user\u2019s words', () => {
    // The agent was already told the reply arrives as its next message, so a
    // prefix here would be geniro narrating over the user in their own
    // conversation.
    expect(deferredAnswerMessage(true, '  Postgres  ')).toBe('Postgres');
    // The other two arms are geniro speaking, and are marked so the model never
    // quotes them back as something a person said.
    expect(deferredAnswerMessage(true, '   ')).toMatch(/^\(/);
    expect(deferredAnswerMessage(false)).toMatch(/^\(/);
    expect(deferredAnswerMessage(false)).toMatch(/dismissed/i);
    expect(deferredAnswerMessage(false)).not.toBe(
      deferredAnswerMessage(true, ''),
    );
  });
});
