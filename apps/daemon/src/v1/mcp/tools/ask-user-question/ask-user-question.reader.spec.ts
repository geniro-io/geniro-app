import { describe, expect, it } from 'vitest';

import { MAX_HOST_QUESTION_TITLE_LENGTH } from '../../../agents/utils/host-question';
import {
  hostQuestionResultText,
  MAX_QUESTION_ARTIFACT_ID_LENGTH,
  readHostQuestionTitle,
  readQuestionArtifacts,
  unknownQuestionArtifactsText,
} from './ask-user-question.reader';

describe('readQuestionArtifacts', () => {
  it('reads none when the argument is absent', () => {
    expect(readQuestionArtifacts({})).toEqual({ ok: true, ids: [] });
  });

  it('reads the ids trimmed, in order, repeats dropped', () => {
    expect(
      readQuestionArtifacts({ artifacts: [' voices ', 'report', 'voices'] }),
    ).toEqual({ ok: true, ids: ['voices', 'report'] });
  });

  it('refuses more than three pages rather than cutting them', () => {
    const read = readQuestionArtifacts({ artifacts: ['a', 'b', 'c', 'd'] });
    expect(read.ok).toBe(false);
  });

  it('refuses a blank entry, a non-array and an id over the length cap', () => {
    expect(readQuestionArtifacts({ artifacts: ['ok', ''] }).ok).toBe(false);
    expect(readQuestionArtifacts({ artifacts: 'voices' }).ok).toBe(false);
    expect(
      readQuestionArtifacts({
        artifacts: ['x'.repeat(MAX_QUESTION_ARTIFACT_ID_LENGTH + 1)],
      }).ok,
    ).toBe(false);
  });
});

describe('unknownQuestionArtifactsText', () => {
  it('names the unknown id and the pages the thread did publish', () => {
    const text = unknownQuestionArtifactsText(['ghost'], ['voices', 'report']);
    expect(text).toContain("'ghost'");
    expect(text).toContain("'voices', 'report'");
    expect(text).toContain('was not asked');
  });

  it('says so when the thread published no page', () => {
    expect(unknownQuestionArtifactsText(['ghost'], [])).toContain(
      'published no page yet',
    );
  });
});

describe('readHostQuestionTitle', () => {
  it('reads a title and truncates it to its cap', () => {
    expect(readHostQuestionTitle({ title: 'Pick a database' })).toBe(
      'Pick a database',
    );
    expect(
      readHostQuestionTitle({
        title: 't'.repeat(MAX_HOST_QUESTION_TITLE_LENGTH + 50),
      }),
    ).toHaveLength(MAX_HOST_QUESTION_TITLE_LENGTH);
  });

  it('answers null for a title that is absent, blank or not a string', () => {
    expect(readHostQuestionTitle({})).toBeNull();
    expect(readHostQuestionTitle({ title: '   ' })).toBeNull();
    expect(readHostQuestionTitle({ title: 7 })).toBeNull();
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
});
