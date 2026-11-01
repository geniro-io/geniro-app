import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import type {
  ItemWire,
  RunOutcomeInput,
  RunOutcomePayload,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { readRunOutcomes } from '../utils/run-outcomes';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { PullRequestCaptureService } from './pull-request-capture.service';
import { RunOutcomeBroker, type RunOutcomeSink } from './run-outcome.broker';
import { RunOutcomeHistoryService } from './run-outcome-history.service';

const PR_URL = 'https://github.com/acme/platform/pull/87';

type RunColumns = Pick<
  Run,
  'teamId' | 'pullRequests' | 'touchedPullRequests' | 'runOutcomes'
>;

interface Harness {
  broker: RunOutcomeBroker;
  rows: { memberId: string | null; kind: string; payload: RunOutcomePayload }[];
  run: RunColumns | null;
  /** Each announce asked of the capture pass: the column as it stood then. */
  announced: (string | null)[];
  approvals: { payload: unknown }[];
  reads: { kinds: string[]; range: unknown }[];
  failColumnWrite: boolean;
}

function setUp(): Harness {
  const harness: Harness = {
    broker: undefined as unknown as RunOutcomeBroker,
    rows: [],
    run: {
      teamId: 'dev-team',
      pullRequests: JSON.stringify([
        { owner: 'acme', repo: 'platform', number: 87, url: PR_URL, seq: 2 },
      ]),
      touchedPullRequests: null,
      runOutcomes: null,
    },
    announced: [],
    approvals: [],
    reads: [],
    failColumnWrite: false,
  };
  const em = { fork: () => em } as unknown as EntityManager;
  const itemDao = {
    rowsOfKinds: async (
      _runId: string,
      kinds: readonly string[],
      range: unknown,
    ) => {
      harness.reads.push({ kinds: [...kinds], range });
      // As the table hands them back: `Item.payload` is the column's JSON text.
      if (kinds.includes('run_outcome')) {
        return harness.rows.map((row, at) => ({
          seq: 101 + at,
          payload: JSON.stringify(row.payload),
          createdAt: new Date('2026-10-27T09:00:00.000Z'),
        }));
      }
      return harness.approvals.map((row) => ({
        payload: JSON.stringify(row.payload),
      }));
    },
  } as unknown as ItemDao;
  const runDao = {
    outcomeContextOf: async () =>
      harness.run === null ? null : { ...harness.run },
    updateWithoutActivity: async (_id: string, data: Partial<Run>) => {
      if (harness.failColumnWrite) {
        throw new Error('database is locked');
      }
      Object.assign(harness.run ?? {}, data);
    },
  } as unknown as RunDao;
  // Two CLIs' question tools, so the count is shown to follow each adapter's
  // own name rather than one CLI's.
  const adapters = {
    all: () =>
      new Map([
        [
          'claude',
          { getConfig: () => ({ questionToolName: 'AskUserQuestion' }) },
        ],
        [
          'cursor-agent',
          { getConfig: () => ({ questionToolName: 'cursor/ask_question' }) },
        ],
        ['other', { getConfig: () => ({ questionToolName: null }) }],
      ]),
  } as unknown as AgentAdapterRegistry;
  const captures = {
    announceOutcome: async () => {
      harness.announced.push(harness.run?.runOutcomes ?? null);
    },
  } as unknown as PullRequestCaptureService;
  harness.broker = new RunOutcomeBroker(
    em,
    runDao,
    new RunOutcomeHistoryService(em, itemDao, adapters),
    captures,
  );
  return harness;
}

function sinkFor(harness: Harness): RunOutcomeSink {
  return {
    persistItem: async (memberId, kind, _role, payload) => {
      harness.rows.push({
        memberId,
        kind,
        payload: payload as RunOutcomePayload,
      });
      return { seq: 100 + harness.rows.length } as ItemWire;
    },
    recorder: (caller) => {
      const [memberId, conversationId] = caller.split('/');
      return {
        memberId: memberId!,
        conversationId: conversationId ?? null,
        callId: conversationId === undefined ? null : `call-${conversationId}`,
      };
    },
  };
}

const INPUT: RunOutcomeInput = {
  prNumber: 87,
  prUrl: PR_URL,
  draft: true,
  reviewRounds: 0,
  acceptance: 'not_yet',
  summary: null,
};

describe('RunOutcomeBroker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records one run_outcome row with the identity read from the URL and the run’s team', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    const outcome = await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      prUrl: `${PR_URL}/files`,
      reviewRounds: 2,
      acceptance: 'accepted',
      draft: false,
    });

    expect(outcome).toEqual({
      status: 'recorded',
      seq: 101,
      questionsAsked: 0,
    });
    expect(harness.rows).toEqual([
      {
        memberId: 'manager',
        kind: 'run_outcome',
        payload: {
          prOwner: 'acme',
          prRepo: 'platform',
          prNumber: 87,
          prUrl: `${PR_URL}/files`,
          draft: false,
          reviewRounds: 2,
          acceptance: 'accepted',
          questionsAsked: 0,
          teamSlug: 'dev-team',
          nodeId: 'manager',
          conversationId: null,
        },
      },
    ]);
  });

  it('keeps the summary the member gave on the row', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      acceptance: 'changes_requested',
      summary: 'The user wants the retry moved behind a flag.',
    });

    expect(harness.rows[0]?.payload).toMatchObject({
      acceptance: 'changes_requested',
      summary: 'The user wants the retry moved behind a flag.',
    });
  });

  it('writes nothing for a call that repeats the pull request’s newest outcome, and records the next change', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    await harness.broker.record('run-1', 'manager', 'manager', INPUT);
    const announcedBefore = harness.announced.length;

    const repeat = await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      prUrl: 'https://github.com/ACME/Platform/pull/87',
      summary: 'Same figures, new words.',
    });
    const changed = await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      reviewRounds: 1,
    });

    expect(repeat).toEqual({ status: 'unchanged', seq: 101 });
    expect(harness.announced.length).toBe(announcedBefore + 1);
    expect(changed).toMatchObject({ status: 'recorded', seq: 102 });
    expect(harness.rows.map((row) => row.payload.reviewRounds)).toEqual([0, 1]);
  });

  it('records a call that changes the draft state alone', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    await harness.broker.record('run-1', 'manager', 'manager', INPUT);

    expect(
      await harness.broker.record('run-1', 'manager', 'manager', {
        ...INPUT,
        draft: false,
      }),
    ).toMatchObject({ status: 'recorded', seq: 102 });
  });

  it('judges a repeat by the newest row, not by a pull-request column whose write failed', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    await harness.broker.record('run-1', 'manager', 'manager', INPUT);
    harness.failColumnWrite = true;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      acceptance: 'changes_requested',
    });

    expect(
      await harness.broker.record('run-1', 'manager', 'manager', INPUT),
    ).toMatchObject({ status: 'recorded', seq: 103 });
    expect(harness.rows.map((row) => row.payload.acceptance)).toEqual([
      'not_yet',
      'changes_requested',
      'not_yet',
    ]);
  });

  it('writes the newest row into a pull-request column that missed it when the agent repeats it', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    await harness.broker.record('run-1', 'manager', 'manager', INPUT);
    harness.failColumnWrite = true;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const changed = { ...INPUT, acceptance: 'changes_requested' as const };
    await harness.broker.record('run-1', 'manager', 'manager', changed);
    harness.failColumnWrite = false;
    const announcedBefore = harness.announced.length;

    expect(
      await harness.broker.record('run-1', 'manager', 'manager', changed),
    ).toEqual({ status: 'unchanged', seq: 102 });
    expect(harness.rows).toHaveLength(2);
    expect(
      readRunOutcomes(harness.run?.runOutcomes).get('acme/platform#87'),
    ).toMatchObject({ seq: 102, acceptance: 'changes_requested' });
    expect(harness.announced.length).toBe(announcedBefore + 1);
  });

  it('catches up a pull request the column missed when another pull request is recorded', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    harness.failColumnWrite = true;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await harness.broker.record('run-1', 'manager', 'manager', INPUT);
    harness.failColumnWrite = false;

    await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      prNumber: 90,
      prUrl: 'https://github.com/acme/platform/pull/90',
    });

    const column = readRunOutcomes(harness.run?.runOutcomes);
    expect(column.get('acme/platform#87')).toMatchObject({ seq: 101 });
    expect(column.get('acme/platform#90')).toMatchObject({ seq: 102 });
  });

  it('files the row under the call the recording conversation answers', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'engineer', sinkFor(harness));

    await harness.broker.record('run-1', 'engineer', 'engineer/c7', INPUT);

    expect(harness.rows[0]?.payload).toMatchObject({
      nodeId: 'engineer',
      conversationId: 'c7',
      callId: 'call-c7',
    });
  });

  it('counts every question put to the user on the run, by any CLI, and nothing else', async () => {
    const harness = setUp();
    harness.approvals = [
      // claude, two questions on one card, normalized.
      {
        payload: {
          toolName: 'AskUserQuestion',
          questions: [{ question: 'a' }, { question: 'b' }],
          input: { questions: [{ question: 'a' }, { question: 'b' }] },
        },
      },
      // claude, an older row with no normalized `questions`.
      {
        payload: {
          toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'c' }] },
        },
      },
      // cursor's own question tool.
      {
        payload: {
          toolName: 'cursor/ask_question',
          questions: [{ prompt: 'd' }],
        },
      },
      // geniro's host question tool.
      { payload: { toolName: 'ask_user_question', questions: [{}, {}, {}] } },
      // A permission card is not a question.
      { payload: { toolName: 'Bash', input: { command: 'gh pr view' } } },
    ];
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    const outcome = await harness.broker.record(
      'run-1',
      'manager',
      'manager',
      INPUT,
    );

    expect(outcome).toMatchObject({ questionsAsked: 7 });
    expect(harness.rows[0]?.payload.questionsAsked).toBe(7);
    expect(harness.reads).toEqual([
      { kinds: ['run_outcome'], range: undefined },
      { kinds: ['approval_request'], range: undefined },
    ]);
  });

  it('counts a question card that lists no questions as one question', async () => {
    const harness = setUp();
    harness.approvals = [
      { payload: { toolName: 'AskUserQuestion', questions: [], input: {} } },
      {
        payload: { toolName: 'cursor/ask_question', input: { questions: [] } },
      },
    ];
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    expect(
      await harness.broker.record('run-1', 'manager', 'manager', INPUT),
    ).toMatchObject({ questionsAsked: 2 });
  });

  it('refuses a URL that is not a pull request, and a number that disagrees with it, writing nothing', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    const notAPullRequest = await harness.broker.record(
      'run-1',
      'manager',
      'manager',
      { ...INPUT, prUrl: 'https://github.com/acme/platform/issues/87' },
    );
    const mismatched = await harness.broker.record(
      'run-1',
      'manager',
      'manager',
      { ...INPUT, prNumber: 88 },
    );

    expect(notAPullRequest).toMatchObject({ status: 'refused' });
    expect(mismatched).toEqual({
      status: 'refused',
      reason: 'pr_number 88 does not match pr_url, which names #87',
    });
    expect(harness.rows).toEqual([]);
    expect(harness.announced).toEqual([]);
  });

  it('keeps the newest outcome per pull request on the run and announces it on the list', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    await harness.broker.record('run-1', 'manager', 'manager', INPUT);
    await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      reviewRounds: 1,
      acceptance: 'accepted',
    });
    await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      prNumber: 90,
      prUrl: 'https://github.com/acme/platform/pull/90',
    });

    const outcomes = readRunOutcomes(harness.run?.runOutcomes);
    expect(outcomes.get('acme/platform#87')).toMatchObject({
      seq: 102,
      acceptance: 'accepted',
      reviewRounds: 1,
    });
    expect(outcomes.get('acme/platform#90')).toMatchObject({ seq: 103 });
    // Announced through the capture pass after each column write, so every
    // announce reads the column that write left.
    expect(
      harness.announced.map(
        (column) => readRunOutcomes(column).get('acme/platform#87')?.seq,
      ),
    ).toEqual([101, 102, 102]);
  });

  it('files an outcome under the same pull request whatever case the URL writes owner and repo in', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    await harness.broker.record('run-1', 'manager', 'manager', INPUT);
    await harness.broker.record('run-1', 'manager', 'manager', {
      ...INPUT,
      prUrl: 'https://github.com/ACME/Platform/pull/87',
      acceptance: 'accepted',
    });

    expect([...readRunOutcomes(harness.run?.runOutcomes).entries()]).toEqual([
      ['acme/platform#87', expect.objectContaining({ seq: 102 })],
    ]);
  });

  it('answers recorded when the row was written but the run’s list could not be updated', async () => {
    const harness = setUp();
    harness.failColumnWrite = true;
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    const warn = vi
      .spyOn(
        (harness.broker as unknown as { log: { warn: () => void } }).log,
        'warn',
      )
      .mockImplementation(() => undefined);

    const outcome = await harness.broker.record(
      'run-1',
      'manager',
      'manager',
      INPUT,
    );

    expect(outcome).toMatchObject({ status: 'recorded', seq: 101 });
    expect(harness.rows).toHaveLength(1);
    expect(harness.announced).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('answers without waiting on the announce, and logs one that fails', async () => {
    const harness = setUp();
    harness.broker.register('run-1', 'manager', sinkFor(harness));
    const warn = vi
      .spyOn(
        (harness.broker as unknown as { log: { warn: () => void } }).log,
        'warn',
      )
      .mockImplementation(() => undefined);
    let rejectAnnounce: (err: Error) => void = () => undefined;
    (
      harness.broker as unknown as {
        captures: { announceOutcome: () => Promise<void> };
      }
    ).captures.announceOutcome = () =>
      new Promise((_resolve, reject) => {
        rejectAnnounce = reject;
      });

    const outcome = await harness.broker.record(
      'run-1',
      'manager',
      'manager',
      INPUT,
    );
    expect(outcome).toMatchObject({ status: 'recorded', seq: 101 });

    rejectAnnounce(new Error('listing failed'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });

  it('refuses a run that no longer exists, writing nothing', async () => {
    const harness = setUp();
    harness.run = null;
    harness.broker.register('run-1', 'manager', sinkFor(harness));

    expect(
      await harness.broker.record('run-1', 'manager', 'manager', INPUT),
    ).toEqual({ status: 'refused', reason: 'this run no longer exists' });
    expect(harness.rows).toEqual([]);
  });

  it('is unavailable to a member no pass registered', async () => {
    const harness = setUp();

    expect(harness.broker.canUse('run-1', 'manager')).toBe(false);
    expect(
      await harness.broker.record('run-1', 'manager', 'manager', INPUT),
    ).toMatchObject({ status: 'unavailable' });
  });
});
