import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cursorProjectKey,
  endingFromTail,
  firstUserText,
  locateCursorDelegateTranscript,
  readCursorDelegateEnding,
} from './cursor-delegate-transcript.utils';

/**
 * The lines below are the shapes read off real transcripts on
 * 2026.09.10-fd3934a (2026-09-30) — a finished reviewer's file ends on the
 * `turn_ended` line, a working one's on an assistant `tool_use`.
 */
const WORKING_LINE = JSON.stringify({
  role: 'assistant',
  message: {
    content: [{ type: 'tool_use', name: 'Read', input: { path: '/x.ts' } }],
  },
});
const ENDED_LINE = (status: string): string =>
  JSON.stringify({ type: 'turn_ended', status });

describe('cursorProjectKey', () => {
  it('files a workspace the way the CLI does', () => {
    // The directory measured on this machine for this very path.
    expect(
      cursorProjectKey(
        '/Users/sergeirazumovskij/Desktop/Projects/ManifestLab/ManifestOS',
      ),
    ).toBe('Users-sergeirazumovskij-Desktop-Projects-ManifestLab-ManifestOS');
    expect(cursorProjectKey('/tmp/my repo/.cursor-x/')).toBe(
      'tmp-my-repo-cursor-x',
    );
  });
});

describe('endingFromTail', () => {
  it('reads the closing line as the ending, with its outcome', () => {
    expect(
      endingFromTail(`${WORKING_LINE}\n${ENDED_LINE('success')}\n`),
    ).toEqual({ state: 'ended', outcome: 'completed' });
    expect(endingFromTail(ENDED_LINE('error'))).toEqual({
      state: 'ended',
      outcome: 'failed',
    });
    expect(endingFromTail(ENDED_LINE('aborted'))).toEqual({
      state: 'ended',
      outcome: 'stopped',
    });
  });

  it('ends a delegate whose status it does not know without claiming how', () => {
    expect(endingFromTail(ENDED_LINE('something-new'))).toEqual({
      state: 'ended',
      outcome: null,
    });
    expect(endingFromTail(JSON.stringify({ type: 'turn_ended' }))).toEqual({
      state: 'ended',
      outcome: null,
    });
  });

  it('reads any other last line as a delegate still working', () => {
    expect(endingFromTail(`${WORKING_LINE}\n`)).toEqual({ state: 'running' });
    expect(endingFromTail('')).toEqual({ state: 'running' });
  });

  it('judges on the LAST line only — an earlier ending was followed by more work', () => {
    expect(
      endingFromTail(`${ENDED_LINE('success')}\n${WORKING_LINE}\n`),
    ).toEqual({ state: 'running' });
  });

  it('reads a half-written last line as still working, not as the line before it', () => {
    // A tail cut mid-write must not fall back to an OLDER line — that line
    // could be an earlier `turn_ended`, and the delegate is demonstrably busy.
    expect(endingFromTail(`${ENDED_LINE('success')}\n{"role":"assist`)).toEqual(
      { state: 'running' },
    );
  });
});

/** The opening line exactly as the CLI writes it — measured 2026-09-30. */
const OPENING_LINE = (brief: string): string =>
  JSON.stringify({
    role: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: `<timestamp>Wednesday, Sep 30, 2026, 11:15 AM (UTC+4)</timestamp>\n<user_query>\n${brief}\n</user_query>`,
        },
      ],
    },
  });

describe('firstUserText', () => {
  it('reads the brief out of the opening user line', () => {
    expect(
      firstUserText(`${OPENING_LINE('You are sub-agent 1.')}\n{}`),
    ).toContain('<user_query>\nYou are sub-agent 1.\n</user_query>');
  });

  it('answers null for anything that is not an opening user line', () => {
    expect(firstUserText(null)).toBeNull();
    expect(firstUserText('')).toBeNull();
    expect(firstUserText(WORKING_LINE)).toBeNull();
    expect(firstUserText('{"role":"us')).toBeNull();
  });
});

describe('cursor transcripts on disk', () => {
  let home: string;
  const cwd = '/Users/me/Projects/App';
  const transcripts = (): string =>
    join(home, 'projects', 'Users-me-Projects-App', 'agent-transcripts');
  const at = (conversationId: string) => ({
    conversationId,
    cwd,
    sessionId: 'parent',
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cursor-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function write(path: string, body: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }

  describe('readCursorDelegateEnding', () => {
    it('reads an ACP delegate, filed under its own conversation id', async () => {
      await write(
        join(transcripts(), 'agent-1', 'agent-1.jsonl'),
        `${WORKING_LINE}\n${ENDED_LINE('success')}\n`,
      );
      await expect(
        readCursorDelegateEnding(at('agent-1'), home),
      ).resolves.toEqual({ state: 'ended', outcome: 'completed' });
    });

    it('reads a delegate nested under its parent conversation', async () => {
      await write(
        join(transcripts(), 'parent', 'subagents', 'agent-2.jsonl'),
        `${WORKING_LINE}\n`,
      );
      await expect(
        readCursorDelegateEnding(at('agent-2'), home),
      ).resolves.toEqual({ state: 'running' });
    });

    it('answers null — cannot tell — when no transcript exists', async () => {
      await expect(
        readCursorDelegateEnding(at('agent-3'), home),
      ).resolves.toBeNull();
    });

    it('reads only the tail of a long transcript', async () => {
      const body =
        `${WORKING_LINE}\n`.repeat(2_000) + `${ENDED_LINE('error')}\n`;
      await write(join(transcripts(), 'agent-4', 'agent-4.jsonl'), body);
      await expect(
        readCursorDelegateEnding(at('agent-4'), home),
      ).resolves.toEqual({ state: 'ended', outcome: 'failed' });
    });
  });

  describe('locateCursorDelegateTranscript', () => {
    const query = (prompt: string, claimed: string[] = []) => ({
      cwd,
      sessionId: 'parent',
      prompt,
      launchedAtMs: Date.now() - 1_000,
      claimed: new Set(claimed),
    });

    it('finds a new delegate by the brief its transcript opens with', async () => {
      await write(
        join(transcripts(), 'agent-a', 'agent-a.jsonl'),
        `${OPENING_LINE('You are sub-agent 1.')}\n`,
      );
      await write(
        join(transcripts(), 'agent-b', 'agent-b.jsonl'),
        `${OPENING_LINE('You are sub-agent 2.')}\n`,
      );
      await expect(
        locateCursorDelegateTranscript(query('You are sub-agent 2.'), home),
      ).resolves.toBe('agent-b');
    });

    it('finds one nested under the parent conversation', async () => {
      await write(
        join(transcripts(), 'parent', 'subagents', 'agent-n.jsonl'),
        `${OPENING_LINE('Nested brief.')}\n`,
      );
      await expect(
        locateCursorDelegateTranscript(query('Nested brief.'), home),
      ).resolves.toBe('agent-n');
    });

    it('never hands one transcript to two delegates with the same brief', async () => {
      await write(
        join(transcripts(), 'agent-x', 'agent-x.jsonl'),
        `${OPENING_LINE('Same brief.')}\n`,
      );
      await expect(
        locateCursorDelegateTranscript(query('Same brief.', ['agent-x']), home),
      ).resolves.toBeNull();
    });

    it('ignores a conversation older than the launch', async () => {
      // Born long before — a previous delegate given the identical brief.
      const path = join(transcripts(), 'agent-old', 'agent-old.jsonl');
      await write(path, `${OPENING_LINE('Old brief.')}\n`);
      await expect(
        locateCursorDelegateTranscript(
          { ...query('Old brief.'), launchedAtMs: Date.now() + 3_600_000 },
          home,
        ),
      ).resolves.toBeNull();
    });

    it('answers null while no transcript carries the brief yet', async () => {
      await expect(
        locateCursorDelegateTranscript(query('Not written yet.'), home),
      ).resolves.toBeNull();
    });
  });
});
