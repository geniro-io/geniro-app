import {
  defineConfig,
  MikroORM,
  type RequiredEntityData,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { kindRowsPassthrough } from '../__tests__/kind-rows-passthrough';
import { TIMELINE_EVENTS_MAX } from '../chat.types';
import { GoalDao } from '../dao/goal.dao';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { ChatTimelineService } from './chat-timeline.service';

const RUN = 'run-ev';
const BASE = Date.UTC(2026, 10, 20, 9);

function at(seq: number): Date {
  return new Date(BASE + seq * 1000);
}

describe('ChatTimelineService events (in-memory sqlite)', () => {
  let orm: MikroORM;
  let seq = 0;
  let pending: RequiredEntityData<Item>[] = [];

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState, Goal],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    seq = 0;
    pending = [];
  });

  function push(
    kind: string,
    payload: unknown,
    extra: { role?: string | null; memberId?: string | null } = {},
  ): number {
    const own = seq;
    seq += 1;
    pending.push({
      id: `i-${own}`,
      runId: RUN,
      seq: own,
      kind: kind as Item['kind'],
      role: extra.role ?? null,
      memberId: extra.memberId ?? null,
      payload: JSON.stringify(payload),
      createdAt: at(own),
      updatedAt: at(own),
    });
    return own;
  }

  /** Persisted through the entity, so its promoted payload columns are stamped. */
  async function flush(pullRequests: unknown[] = []): Promise<void> {
    const em = orm.em.fork();
    await new RunDao(em).create({
      id: RUN,
      status: 'running',
      teamId: 'dev-team',
      pullRequests:
        pullRequests.length === 0 ? null : JSON.stringify(pullRequests),
    });
    for (const data of pending) {
      em.persist(em.create(Item, data));
    }
    await em.flush();
  }

  async function goal(
    number: number,
    status: string,
    closedAt: Date | null,
  ): Promise<void> {
    const em = orm.em.fork();
    em.persist(
      em.create(Goal, {
        runId: RUN,
        number,
        text: `goal ${number}`,
        source: 'user',
        status: status as Goal['status'],
        closedAt,
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    await em.flush();
  }

  function service(): ChatTimelineService {
    const em = orm.em.fork();
    const items = new ItemDao(em);
    return new ChatTimelineService(
      em,
      items,
      new RunDao(em),
      kindRowsPassthrough(items),
      new GoalDao(em),
    );
  }

  it('reads every source into one newest-first list, past a long run of tool rows', async () => {
    push('message', { text: 'please fix it' }, { role: 'user' });
    const started = push('message', { text: 'on it' }, { role: 'assistant' });
    for (let n = 0; n < 600; n += 1) {
      push(
        'tool_call',
        { id: `t${n}`, name: 'Bash', input: {} },
        { role: 'assistant' },
      );
      push('tool_result', { id: `t${n}`, result: 'ok' }, { role: 'tool' });
    }
    push('stage_change', {
      action: 'nudge',
      stageId: 's',
      stageTitle: 'Build',
      text: '',
      rev: 1,
      by: { kind: 'system' },
    });
    push('stage_change', {
      action: 'stalled',
      stageId: 's',
      stageTitle: 'Build',
      text: '',
      rev: 1,
      by: { kind: 'system' },
    });
    const stage = push('stage_change', {
      action: 'complete',
      stageId: 's',
      stageTitle: 'Build or change',
      text: '',
      rev: 2,
      by: { kind: 'agent', nodeId: 'senior' },
    });
    const error = push('error', {
      message: 'usage limit reached\nretry at 5pm',
    });
    push(
      'call_started',
      {
        callId: 'c1',
        callerNodeId: 'lead',
        calleeNodeId: 'senior',
        mode: 'sync',
        message: 'go',
        title: 'Build the fix',
      },
      { memberId: 'lead' },
    );
    push(
      'call_result',
      {
        callId: 'c1',
        callerNodeId: 'lead',
        calleeNodeId: 'senior',
        mode: 'sync',
        status: 'ok',
        result: 'done',
      },
      { memberId: 'lead' },
    );
    const failedCall = push(
      'call_result',
      {
        callId: 'c2',
        callerNodeId: 'lead',
        calleeNodeId: 'qa',
        mode: 'sync',
        status: 'error',
        error: 'CALLEE_FAILED: crashed',
      },
      { memberId: 'lead' },
    );
    const asked = push('approval_request', {
      id: 'q1',
      toolName: 'AskUserQuestion',
      input: {},
      questions: [{ question: 'Ship it?' }],
    });
    push('approval_verdict', { id: 'q1', allow: true });
    const approval = push('approval_request', {
      id: 'a1',
      toolName: 'Bash',
      input: {},
    });
    const findings = push('report_findings', {
      findings: [
        { file: 'a.ts', summary: 'null deref' },
        { file: 'b.ts', summary: 'race' },
      ],
    });
    push('report_findings', {
      findings: [{ file: 'a.ts', summary: 'null deref', outcome: 'fixed' }],
    });
    const note = push('team_note', {
      kind: 'decision',
      text: 'one PR',
      nodeId: 'lead',
      conversationId: null,
    });
    const page = push('show_artifact', {
      artifactId: 'p',
      version: 1,
      title: 'Plan page',
      key: 'k',
    });
    const step = push(
      'milestone',
      {
        text: 'Found the cause',
        kind: 'problem',
        nodeId: 'senior',
        conversationId: null,
      },
      { memberId: 'senior' },
    );
    const review = push('run_outcome', {
      prOwner: 'o',
      prRepo: 'r',
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      draft: true,
      reviewRounds: 0,
      acceptance: 'not_yet',
      questionsAsked: 0,
      teamSlug: null,
      nodeId: 'lead',
      conversationId: null,
    });
    const prRow = push(
      'tool_result',
      { id: 'gh', result: 'https://github.com/o/r/pull/7' },
      { role: 'tool' },
    );
    const finished = push('thread_outcome', {
      kind: 'success',
      summary: 'Shipped',
      teamSlug: null,
      nodeId: 'lead',
      conversationId: null,
    });
    await flush([
      {
        owner: 'o',
        repo: 'r',
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        seq: prRow,
      },
    ]);
    await goal(1, 'achieved', at(finished + 5));
    await goal(2, 'open', null);

    const { events, eventsPartialReason } = await service().read(RUN);

    expect(eventsPartialReason).toBeNull();
    expect(events.map((e) => [e.kind, e.seq])).toEqual([
      ['goal', null],
      ['finished', finished],
      ['pull_request', prRow],
      ['review', review],
      ['step', step],
      ['page', page],
      ['note', note],
      ['problems', findings],
      ['approval', approval],
      ['asked', asked],
      ['failure', failedCall],
      ['call', failedCall - 2],
      ['failure', error],
      ['stage', stage],
      ['started', started],
    ]);
    const byKind = (kind: string) => events.find((e) => e.kind === kind)!;
    expect(byKind('pull_request')).toMatchObject({
      at: at(prRow).toISOString(),
      text: '#7',
      url: 'https://github.com/o/r/pull/7',
    });
    expect(byKind('asked')).toMatchObject({ text: 'Ship it?', open: false });
    expect(byKind('approval')).toMatchObject({ text: 'Bash', open: true });
    expect(byKind('stage')).toMatchObject({
      memberId: 'senior',
      text: 'Build or change',
      detail: 'complete',
    });
    expect(byKind('step')).toMatchObject({
      memberId: 'senior',
      text: 'Found the cause',
      detail: 'problem',
    });
    expect(byKind('problems')).toMatchObject({
      detail: '2',
      text: 'null deref',
    });
    expect(events.find((e) => e.id === `failure:i-${error}`)?.text).toBe(
      'usage limit reached',
    );
    expect(events.filter((e) => e.kind === 'goal').map((e) => e.text)).toEqual([
      'goal 1',
    ]);
  });

  it('keeps the newest events and says the thread starts earlier when it holds more', async () => {
    for (let n = 0; n < TIMELINE_EVENTS_MAX + 30; n += 1) {
      push('milestone', {
        text: `step ${n}`,
        kind: 'progress',
        nodeId: 'a',
        conversationId: null,
      });
    }
    await flush();

    const { events, eventsPartialReason } = await service().read(RUN);

    expect(events).toHaveLength(TIMELINE_EVENTS_MAX);
    expect(events[0]!.text).toBe(`step ${TIMELINE_EVENTS_MAX + 29}`);
    expect(events.at(-1)!.text).toBe('step 30');
    expect(eventsPartialReason).toMatch(/newest 200 events/);
  });

  it('says nothing is missing when the list holds exactly every event', async () => {
    for (let n = 0; n < TIMELINE_EVENTS_MAX; n += 1) {
      push('milestone', {
        text: `step ${n}`,
        kind: 'done',
        nodeId: 'a',
        conversationId: null,
      });
    }
    await flush();

    const { events, eventsPartialReason } = await service().read(RUN);

    expect(events).toHaveLength(TIMELINE_EVENTS_MAX);
    expect(eventsPartialReason).toBeNull();
  });

  it('finds a failed call behind more successful calls than the list holds', async () => {
    const failed = push('call_result', {
      callId: 'c0',
      calleeNodeId: 'qa',
      status: 'error',
      error: 'boom',
    });
    for (let n = 0; n < TIMELINE_EVENTS_MAX + 50; n += 1) {
      push('call_result', {
        callId: `c${n + 1}`,
        calleeNodeId: 'qa',
        status: 'ok',
        result: 'fine',
      });
    }
    await flush();

    const { events } = await service().read(RUN);

    expect(events.map((e) => [e.kind, e.seq])).toEqual([['failure', failed]]);
  });
});
