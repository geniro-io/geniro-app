import { describe, expect, it } from 'vitest';

import {
  questionAttachmentSetOf,
  readQuestionAttachmentSet,
} from './question-attachments-payload';

const PAGE = {
  kind: 'artifact',
  artifactId: 'pr-673-acceptance',
  title: 'PR #673 — acceptance',
  version: 2,
};

describe('readQuestionAttachmentSet', () => {
  it('reads nothing from a record written before attachments existed', () => {
    expect(
      readQuestionAttachmentSet({
        toolName: 'ask_user_question',
        questions: [],
      }),
    ).toBeNull();
    expect(questionAttachmentSetOf(null)).toBeNull();
  });

  it('reads an empty list as a question that attached nothing', () => {
    expect(
      readQuestionAttachmentSet({
        toolName: 'ask_user_question',
        attachments: [],
      }),
    ).toEqual({ attachments: [] });
  });

  it('reads exactly the page entries of an ask_user_question row and drops a gallery entry', () => {
    const gallery = {
      kind: 'gallery',
      seq: 5,
      gallery: { title: 'Shots', images: [{ path: '/tmp/a.png' }] },
    };
    expect(
      readQuestionAttachmentSet({
        toolName: 'ask_user_question',
        attachments: [gallery, PAGE],
      }),
    ).toEqual({ attachments: [PAGE] });
  });

  it('lists a page listed twice once, at the version its first entry names', () => {
    const other = { ...PAGE, artifactId: 'plan', title: 'Plan', version: 1 };
    expect(
      readQuestionAttachmentSet({
        toolName: 'ask_user_question',
        attachments: [PAGE, other, { ...PAGE, version: 3 }],
      }),
    ).toEqual({ attachments: [PAGE, other] });
  });

  it('drops each malformed entry alone and keeps the rest', () => {
    expect(
      readQuestionAttachmentSet({
        toolName: 'ask_user_question',
        attachments: [
          { ...PAGE, artifactId: '' },
          'not a page',
          { ...PAGE, version: 0 },
          PAGE,
        ],
      }),
    ).toEqual({ attachments: [PAGE] });
  });

  it('reads no page from a question another tool asked, whatever pages its row stores', () => {
    for (const toolName of ['AskUserQuestion', 'request_user_input']) {
      expect(
        readQuestionAttachmentSet({ toolName, attachments: [PAGE] }),
      ).toEqual({ attachments: [] });
    }
  });

  it('reads a relayed card the same way, by the tool its thread asked with', () => {
    const relayed = {
      threadRunId: 'thread-1',
      toolName: 'ask_user_question',
      input: {},
      attachments: [PAGE, PAGE],
    };
    expect(readQuestionAttachmentSet(relayed)).toEqual({ attachments: [PAGE] });
    expect(
      readQuestionAttachmentSet({ ...relayed, toolName: 'AskUserQuestion' }),
    ).toEqual({ attachments: [] });
  });

  it('reads the attachments of a question row payload', () => {
    expect(
      questionAttachmentSetOf({
        toolName: 'ask_user_question',
        attachments: [PAGE],
      }),
    ).toEqual({ attachments: [PAGE] });
  });
});
