import { describe, expect, it } from 'vitest';

import { readThreadStart } from './thread-start-payload';
import type { ToolPair } from './transcript-groups';

function pair(
  input: unknown,
  result: { text: string; isError?: boolean } | null,
): ToolPair {
  const row = (payload: unknown): ToolPair['call'] =>
    ({ id: 'row', payload }) as ToolPair['call'];
  return {
    call: row({ id: 'c1', name: 'start_thread', input }),
    result:
      result === null
        ? null
        : row({
            id: 'c1',
            result: [{ type: 'text', text: result.text }],
            isError: result.isError ?? false,
          }),
  };
}

const ARGS = {
  project: 'ManifestOS',
  title: 'CI-1233: Case page slow',
  brief: 'Find why',
  agent: 'claude',
};

describe('readThreadStart', () => {
  it('reads the call alone while its result is out', () => {
    expect(readThreadStart(pair(ARGS, null))).toEqual({
      title: 'CI-1233: Case page slow',
      project: 'ManifestOS',
      brief: 'Find why',
      agent: 'claude',
      team: null,
      taskId: null,
      startId: null,
      identifier: null,
      answer: null,
      reason: null,
    });
  });

  it('reads the filed card out of the first line of the result', () => {
    const read = readThreadStart(
      pair(
        { ...ARGS, agent: undefined, team: 'dev-team' },
        {
          text: '{"status":"card_shown","taskId":"task-1","identifier":"MAN-16"}\nCard MAN-16 is filed and a Start card is on screen for the user.',
        },
      ),
    );
    expect(read).toMatchObject({
      agent: null,
      team: 'dev-team',
      taskId: 'task-1',
      identifier: 'MAN-16',
      answer: 'card_shown',
      reason: null,
    });
  });

  it('keeps a card with no identifier, as a project with no card key files one', () => {
    const read = readThreadStart(
      pair(ARGS, {
        text: '{"status":"starting","taskId":"task-2","identifier":null}\nCard task-2 is starting now.',
      }),
    );
    expect(read).toMatchObject({
      taskId: 'task-2',
      identifier: null,
      answer: 'starting',
    });
  });

  it('reads a thread filed with no card by its startId, and no identifier', () => {
    const read = readThreadStart(
      pair(ARGS, {
        text: '{"status":"card_shown","startId":"start-1"}\nA Start card is on screen for the user; no board card was filed.',
      }),
    );
    expect(read).toMatchObject({
      taskId: null,
      startId: 'start-1',
      identifier: null,
      answer: 'card_shown',
      reason: null,
    });
  });

  it('reads a refusal as its reason, without the code', () => {
    const read = readThreadStart(
      pair(ARGS, {
        text: 'PROJECT_NOT_FOUND: no project has the id or name "Manifest"',
      }),
    );
    expect(read).toMatchObject({
      taskId: null,
      answer: 'refused',
      reason: 'no project has the id or name "Manifest"',
    });
  });

  it('reads an error result as refused, never as a filed card', () => {
    const read = readThreadStart(
      pair(ARGS, {
        text: '{"status":"starting","taskId":"task-3","identifier":"MAN-1"}',
        isError: true,
      }),
    );
    expect(read).toMatchObject({ taskId: null, answer: 'refused' });
  });
});
