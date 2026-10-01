import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cursorProjectKey,
  endingFromTail,
  firstUserText,
  lastAssistantText,
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
const REPORT_LINE = JSON.stringify({
  role: 'assistant',
  message: { content: [{ type: 'text', text: 'Found 2 bugs.' }] },
});

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

describe('lastAssistantText', () => {
  it('reads the report — the last assistant line with text', () => {
    expect(
      lastAssistantText(
        [REPORT_LINE, WORKING_LINE, ENDED_LINE('success')].join('\n'),
      ),
    ).toBe('Found 2 bugs.');
  });

  it('skips a line cut at the start of the tail rather than misreading it', () => {
    expect(
      lastAssistantText(`ant","message":{}}\n${ENDED_LINE('success')}`),
    ).toBeNull();
  });
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
      const path = join(transcripts(), 'agent-1', 'agent-1.jsonl');
      await write(
        path,
        `${WORKING_LINE}\n${REPORT_LINE}\n${ENDED_LINE('success')}\n`,
      );
      // With the report and where it came from — what the parent's wake
      // prompt carries, since nothing else hands it over.
      await expect(
        readCursorDelegateEnding(at('agent-1'), home),
      ).resolves.toEqual({
        state: 'ended',
        outcome: 'completed',
        finalText: 'Found 2 bugs.',
        recordPath: path,
      });
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
      ).resolves.toMatchObject({
        state: 'ended',
        outcome: 'failed',
        finalText: null,
      });
    });
  });

  describe('locateCursorDelegateTranscript', () => {
    /** `claimed` as conversation → its claimant's brief. */
    const query = (prompt: string, claimed: [string, string][] = []) => ({
      cwd,
      sessionId: 'parent',
      prompt,
      launchedAtMs: Date.now() - 1_000,
      claimed: new Map(claimed),
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
        locateCursorDelegateTranscript(
          query('Same brief.', [['agent-x', 'Same brief.']]),
          home,
        ),
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

    describe('a RESUMED delegate, which writes no new transcript', () => {
      // Measured on run `bd1e43ae`: cursor continued seven cut-off reviewers by
      // appending each new brief to the reviewer's existing transcript, born
      // nine minutes before the relaunch and opening with the ORIGINAL brief.
      const resumedLater = async (
        id: string,
        latestBrief: string,
        touched: boolean,
      ): Promise<void> => {
        const path = join(transcripts(), id, `${id}.jsonl`);
        await write(
          path,
          [
            OPENING_LINE('You are the bugs reviewer.'),
            WORKING_LINE,
            OPENING_LINE(latestBrief),
            WORKING_LINE,
          ].join('\n') + '\n',
        );
        // Born long BEFORE the launch below; written to since only when
        // `touched`. Off the launch, never the clock — which these cases fake.
        const written =
          (touched ? launchedAtMs + 60_000 : launchedAtMs - 3_600_000) / 1000;
        await utimes(path, written, written);
      };
      // Launched an hour from the files' birth, and looked up an hour after
      // that — the resumed rule is only tried once a NEW transcript would
      // already have appeared.
      const launchedAtMs = Date.now() + 3_600_000;
      const later = (prompt: string, claimed: [string, string][] = []) => ({
        ...query(prompt, claimed),
        launchedAtMs,
      });

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(launchedAtMs + 3_600_000);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('is found by the brief its LATEST user message carries', async () => {
        await resumedLater('agent-r', 'Finish the bugs review.', true);
        await expect(
          locateCursorDelegateTranscript(
            later('Finish the bugs review.'),
            home,
          ),
        ).resolves.toBe('agent-r');
      });

      it('is not found by its original brief, which another launch was given', async () => {
        await resumedLater('agent-r', 'Finish the bugs review.', true);
        await expect(
          locateCursorDelegateTranscript(
            later('You are the bugs reviewer.'),
            home,
          ),
        ).resolves.toBeNull();
      });

      it('is not found in a transcript untouched since the launch', async () => {
        await resumedLater('agent-r', 'Finish the bugs review.', false);
        await expect(
          locateCursorDelegateTranscript(
            later('Finish the bugs review.'),
            home,
          ),
        ).resolves.toBeNull();
      });

      it('is handed over from the cut-off delegate still claiming it', async () => {
        // The original reviewer never wrote `turn_ended`, so it is still out
        // and still holds the transcript its continuation is writing into.
        await resumedLater('agent-r', 'Finish the bugs review.', true);
        await expect(
          locateCursorDelegateTranscript(
            later('Finish the bugs review.', [
              ['agent-r', 'You are the bugs reviewer.'],
            ]),
            home,
          ),
        ).resolves.toBe('agent-r');
      });

      it('is NOT taken from a delegate whose own brief is still the latest', async () => {
        await resumedLater('agent-r', 'Finish the bugs review.', true);
        await expect(
          locateCursorDelegateTranscript(
            later('Finish the bugs review.', [
              ['agent-r', 'Finish the bugs review.'],
            ]),
            home,
          ),
        ).resolves.toBeNull();
      });

      it('is not tried before a new transcript would have appeared', async () => {
        await resumedLater('agent-r', 'Finish the bugs review.', true);
        vi.setSystemTime(launchedAtMs + 5_000);
        await expect(
          locateCursorDelegateTranscript(
            later('Finish the bugs review.'),
            home,
          ),
        ).resolves.toBeNull();
      });

      it('never matches the parent’s own conversation, which quotes the brief', async () => {
        await resumedLater('parent', 'Finish the bugs review.', true);
        await expect(
          locateCursorDelegateTranscript(
            later('Finish the bugs review.'),
            home,
          ),
        ).resolves.toBeNull();
      });
    });

    it('answers null while no transcript carries the brief yet', async () => {
      await expect(
        locateCursorDelegateTranscript(query('Not written yet.'), home),
      ).resolves.toBeNull();
    });
  });
});
