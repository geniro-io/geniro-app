import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind, RunStatus } from '../../runs/runs.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { ApprovalRegistry } from './approval-registry';
import type { ChatShellsService } from './chat-shells.service';
import { RunStateService } from './run-state.service';

/**
 * Real-driver spec, on `item.dao.spec.ts`'s pattern: the reads here filter on
 * `json_extract`, which only a real SQLite can say is right.
 */
describe('RunStateService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let runs: RunDao;
  let approvals: ApprovalRegistry;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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
    items = new ItemDao(orm.em.fork());
    runs = new RunDao(orm.em.fork());
    approvals = new ApprovalRegistry();
  });

  function service(): RunStateService {
    const shells = {
      read: () => Promise.resolve({ shells: [] }),
    } as unknown as ChatShellsService;
    // Two CLIs, as a workflow mixes them: one names its launches, one does not.
    const adapters = {
      all: () =>
        new Map([
          [
            'claude',
            {
              getConfig: () => ({
                subagents: { launchToolNames: ['Task', 'Agent'] },
                artifactToolNames: ['Artifact'],
              }),
            },
          ],
          [
            'cursor-agent',
            {
              getConfig: () => ({
                subagents: { launchToolNames: [] },
                artifactToolNames: [],
              }),
            },
          ],
        ]),
    } as unknown as AgentAdapterRegistry;
    return new RunStateService(
      orm.em,
      runs,
      items,
      approvals,
      shells,
      adapters,
    );
  }

  async function createRun(
    status: RunStatus,
    workflowId: string | null = null,
  ): Promise<void> {
    await runs.create({ id: 'run-a', status, workflowId });
  }

  async function insert(
    seq: number,
    kind: ItemKind,
    payload: unknown,
    extra: { nodeId?: string | null; role?: string; at?: number } = {},
  ): Promise<void> {
    await items.create({
      runId: 'run-a',
      seq,
      kind,
      nodeId: extra.nodeId ?? null,
      role: extra.role ?? null,
      payload: JSON.stringify(payload),
      ...(extra.at === undefined ? {} : { createdAt: new Date(extra.at) }),
    });
  }

  it('answers a run that does not exist with a 404', async () => {
    await expect(service().read('nope')).rejects.toThrow(/not found/);
  });

  it('returns the cards the registry still holds, as the rows they were persisted as', async () => {
    await createRun('running');
    await insert(1, 'approval_request', { id: 'req-old', toolName: 'Bash' });
    await insert(2, 'approval_request', { id: 'req-open', toolName: 'Bash' });
    approvals.track({
      runId: 'run-a',
      nodeId: 'agent',
      requestId: 'req-open',
      toolName: 'Bash',
      input: {},
      question: false,
      respond: vi.fn(() => true),
    });

    const state = await service().read('run-a');

    expect(state.openRequests.map((row) => row.seq)).toEqual([2]);
  });

  it('lists every call with its standing, over the whole run', async () => {
    await createRun('running', 'dev-team');
    await insert(1, 'call_started', { callId: 'call-1', calleeNodeId: 'qa' });
    await insert(2, 'call_started', { callId: 'call-2', calleeNodeId: 'qa' });
    await insert(3, 'call_result', { callId: 'call-1', status: 'ok' });

    const state = await service().read('run-a');

    expect(state.calls.map((call) => [call.callId, call.status])).toEqual([
      ['call-1', 'completed'],
      ['call-2', 'running'],
    ]);
  });

  it('lists delegates launched by name AND by declaration, each with its launch reply', async () => {
    await createRun('running');
    await insert(1, 'tool_call', {
      id: 'toolu_a',
      name: 'Task',
      input: { description: 'Review bugs' },
    });
    await insert(2, 'tool_call', { id: 'toolu_b', name: 'Bash', input: {} });
    await insert(3, 'subagent_info', {
      id: 'cursor-1',
      label: 'Review PR',
      backgroundOpen: true,
    });
    await insert(4, 'tool_result', { id: 'toolu_a', result: 'done' });

    const state = await service().read('run-a');

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.status]),
    ).toEqual([
      ['toolu_a', 'completed'],
      ['cursor-1', 'running'],
    ]);
  });

  it('does not list another CLI’s command row titled `task` as a delegate', async () => {
    // The names are pooled over every adapter; matched case-blind, a cursor
    // `execute` row running go-task would be counted as claude's `Task`.
    await createRun('running');
    await insert(1, 'tool_call', { id: 'exec-1', name: 'task', input: {} });
    await insert(2, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    // An artifact name, by contrast, is read ignoring case on both sides.
    await insert(3, 'tool_call', { id: 'art-1', name: 'ARTIFACT', input: {} });

    const state = await service().read('run-a');

    expect(state.delegates.map((delegate) => delegate.id)).toEqual(['toolu_a']);
    expect(
      state.artifactRows.map((row) => (row.payload as { id?: string }).id),
    ).toEqual(['art-1']);
  });

  it('reads an unanswered delegate as stopped once its launching turn ended, but not a backgrounded one', async () => {
    // The run is working again — a later turn — so the run's own status says
    // nothing about a sync delegate the user's Stop cut off.
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_sync', name: 'Task', input: {} });
    await insert(2, 'tool_call', { id: 'toolu_bg', name: 'Task', input: {} });
    await insert(3, 'subagent_info', { id: 'toolu_bg', backgroundOpen: true });
    await insert(4, 'turn_cancelled', {});
    await insert(5, 'message', { text: 'next' }, { role: 'user' });

    const state = await service().read('run-a');

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.status]),
    ).toEqual([
      ['toolu_sync', 'cancelled'],
      ['toolu_bg', 'running'],
    ]);
  });

  it('closes a delegate only on ITS turn’s ending — same node, same call, a real end', async () => {
    await createRun('running', 'dev-team');
    const qa = { nodeId: 'qa' };
    await insert(
      1,
      'tool_call',
      { id: 'toolu_a', name: 'Task', input: {}, callId: 'call-3' },
      qa,
    );
    // Not its turn: another node, another call, and a continuation that
    // finished inside the turn.
    await insert(2, 'turn_complete', {}, { nodeId: 'manager' });
    await insert(3, 'turn_complete', { callId: 'call-9' }, qa);
    await insert(
      4,
      'turn_complete',
      { callId: 'call-3', insideTurn: true },
      qa,
    );

    expect((await service().read('run-a')).delegates[0]!.status).toBe(
      'running',
    );

    await insert(5, 'turn_cancelled', { callId: 'call-3' }, qa);

    expect((await service().read('run-a')).delegates[0]!.status).toBe(
      'cancelled',
    );
  });

  it('closes only the delegates launched BEFORE a turn ended — a later turn’s keeps working', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    await insert(2, 'turn_cancelled', {});
    await insert(3, 'message', { text: 'again' }, { role: 'user' });
    await insert(4, 'tool_call', { id: 'toolu_b', name: 'Task', input: {} });

    const state = await service().read('run-a');

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.status]),
    ).toEqual([
      ['toolu_a', 'cancelled'],
      ['toolu_b', 'running'],
    ]);
  });

  it('keeps delegates, artifacts and workflows apart in one pass over the tool rows', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_d', name: 'Task', input: {} });
    await insert(2, 'tool_call', { id: 'art-1', name: 'Artifact', input: {} });
    await insert(3, 'tool_call', { id: 'wf-1', name: 'Workflow' });
    await insert(4, 'workflow_info', { id: 'wf-1', title: 'Audit' });
    await insert(5, 'tool_result', { id: 'toolu_d', result: 'done' });
    await insert(6, 'tool_result', { id: 'art-1', result: 'https://x' });
    await insert(7, 'tool_result', { id: 'wf-1', result: 'ok' });

    const state = await service().read('run-a');

    expect(state.delegates.map((delegate) => delegate.id)).toEqual(['toolu_d']);
    expect(state.artifactRows.map((row) => row.seq)).toEqual([2, 6]);
    expect(state.workflowRows.map((row) => row.seq)).toEqual([3, 4, 7]);
  });

  it("returns a dynamic workflow's launch, its reply and its first and newest announcement", async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'wf-1', name: 'Workflow' });
    await insert(2, 'workflow_info', { id: 'wf-1', title: 'Audit' });
    await insert(3, 'workflow_info', { id: 'wf-1', agents: [] });
    await insert(4, 'workflow_info', { id: 'wf-1', agents: [{}] });
    await insert(5, 'tool_result', { id: 'wf-1', result: 'ok' });

    const state = await service().read('run-a');

    expect(state.workflowRows.map((row) => row.seq)).toEqual([1, 2, 4, 5]);
  });

  it('returns artifact publishes and their replies, and nothing else', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'art-1', name: 'Artifact', input: {} });
    await insert(2, 'tool_call', { id: 'other', name: 'Write', input: {} });
    await insert(3, 'tool_result', { id: 'art-1', result: 'https://x' });
    await insert(4, 'tool_result', { id: 'other', result: 'ok' });

    const state = await service().read('run-a');

    expect(state.artifactRows.map((row) => row.seq)).toEqual([1, 3]);
  });

  it("dates a running chat's turn from its FIRST user message since the last turn ended", async () => {
    await createRun('running');
    await insert(1, 'message', { text: 'old' }, { role: 'user', at: 1000 });
    await insert(2, 'turn_complete', {}, { at: 2000 });
    await insert(3, 'message', { text: 'now' }, { role: 'user', at: 3000 });
    // A follow-up delivered into the running turn joins it.
    await insert(4, 'message', { text: 'and' }, { role: 'user', at: 4000 });

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(3000).toISOString());
  });

  it('keeps the turn open across a continuation that finished INSIDE it', async () => {
    // An `insideTurn` completion ended nothing; the renderer's turn scan
    // measures the open turn from it when it carries the CLI's own figure.
    await createRun('running');
    await insert(1, 'message', { text: 'go' }, { role: 'user', at: 1000 });
    await insert(
      2,
      'turn_complete',
      { insideTurn: true, usage: { durationMs: 900 } },
      { at: 5000 },
    );

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(5000).toISOString());
  });

  it('keeps the user message as the start when the inside continuation reported no figure', async () => {
    await createRun('running');
    await insert(1, 'message', { text: 'go' }, { role: 'user', at: 1000 });
    await insert(2, 'turn_complete', { insideTurn: true }, { at: 5000 });

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(1000).toISOString());
  });

  it('dates no turn for a settled chat', async () => {
    await createRun('completed');
    await insert(1, 'message', { text: 'q' }, { role: 'user', at: 1000 });
    expect((await service().read('run-a')).turnStartedAt).toBeNull();
  });

  it('dates no turn for a running WORKFLOW run — its turns are its nodes’', async () => {
    await createRun('running', 'dev-team');
    await insert(1, 'message', { text: 'q' }, { role: 'user', at: 1000 });
    expect((await service().read('run-a')).turnStartedAt).toBeNull();
  });
});
