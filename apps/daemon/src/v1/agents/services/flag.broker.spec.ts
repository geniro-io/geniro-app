import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { AgentFlag } from '../../runs/entity/agent-flag.entity';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { AGENT_FLAGS_PER_CONVERSATION } from '../chat.types';
import { AgentFlagDao } from '../dao/agent-flag.dao';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { agentFlagWire } from '../utils/agent-flags';
import { FlagBroker } from './flag.broker';

describe('FlagBroker.raiseAutomatic', () => {
  let orm: MikroORM;
  let broker: FlagBroker;
  let flags: AgentFlagDao;
  const disposers: (() => void)[] = [];

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, AgentFlag],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
        schemaGenerator: mikroOrmConfig.schemaGenerator,
      }),
    );
    await orm.schema.update({ safe: true });
    flags = new AgentFlagDao(orm.em);
    broker = new FlagBroker(
      orm.em,
      new RunDao(orm.em),
      new ItemDao(orm.em),
      flags,
    );
  });

  afterAll(async () => {
    await orm.close();
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    const em = orm.em.fork();
    await em.nativeDelete(AgentFlag, {});
    await em.nativeDelete(Item, {});
    await em.nativeDelete(Run, {});
  });

  const seedRun = async (id: string, extra: Partial<Run> = {}) => {
    const em = orm.em.fork();
    em.persist(
      Object.assign(new Run(), { id, status: 'running', ...extra } as Run),
    );
    await em.flush();
  };

  const seedItem = async (runId: string, seq: number) => {
    const em = orm.em.fork();
    em.persist(
      Object.assign(new Item(), {
        runId,
        seq,
        kind: 'message',
        role: 'assistant',
        payload: JSON.stringify({ text: 'hi' }),
      } as Item),
    );
    await em.flush();
  };

  const auto = (cause: string, extra: { seq?: number | null } = {}) => ({
    cause,
    seq: extra.seq ?? null,
    memberId: 'senior',
    conversationId: 'conv-1',
    caller: 'senior',
    summary: `geniro failure: ${cause}`,
    detail: 'what the daemon saw',
    minutesLost: 4,
  });

  const agentFlag = (runId: string, summary: string) =>
    broker.raise(runId, 'senior', 'senior', {
      cost: 'work',
      category: 'geniro_tool',
      summary,
      detail: null,
      minutesLost: 5,
    });

  it('writes a work flag in geniro_tool marked automatic, stamped from the run', async () => {
    await seedRun('run-team', {
      teamId: 'dev-team',
      projectId: 'project-1',
      title: 'Ship the export',
    });
    await seedItem('run-team', 7);

    const handle = await broker.raiseAutomatic(
      'run-team',
      auto('interrupted:crash', { seq: 5 }),
    );

    expect(handle).toMatch(/^F-[0-9a-f]{6}$/);
    const [row, ...rest] = await flags.forRun('run-team', 100);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      handle,
      seq: 5,
      memberId: 'senior',
      conversationId: 'conv-1',
      teamSlug: 'dev-team',
      projectId: 'project-1',
      runKind: 'team',
      runTitle: 'Ship the export',
      cost: 'work',
      category: 'geniro_tool',
      minutesLost: 4,
      summary: 'geniro failure: interrupted:crash',
      detail: 'what the daemon saw',
      automatic: true,
      autoCause: 'interrupted:crash',
    });
    expect(agentFlagWire(row!).automatic).toBe(true);
  });

  it('reads the run’s newest row when no seq is given', async () => {
    await seedRun('run-1');
    await seedItem('run-1', 12);
    await broker.raiseAutomatic('run-1', auto('tool_failure:browser_click'));
    const [row] = await flags.forRun('run-1', 100);
    expect(row?.seq).toBe(12);
  });

  it('writes one flag per cause per thread, racing calls and later calls included', async () => {
    await seedRun('run-1');
    await seedRun('run-2');

    const raced = await Promise.all([
      broker.raiseAutomatic('run-1', auto('tool_refused:browser_click')),
      broker.raiseAutomatic('run-1', auto('tool_refused:browser_click')),
    ]);
    const later = await broker.raiseAutomatic(
      'run-1',
      auto('tool_refused:browser_click'),
    );
    const otherCause = await broker.raiseAutomatic(
      'run-1',
      auto('tool_failure:browser_click'),
    );
    const otherThread = await broker.raiseAutomatic(
      'run-2',
      auto('tool_refused:browser_click'),
    );

    expect(raced.filter((handle) => handle !== null)).toHaveLength(1);
    expect(later).toBeNull();
    expect(otherCause).not.toBeNull();
    expect(otherThread).not.toBeNull();
    expect(
      (await flags.forRun('run-1', 100)).map((row) => row.autoCause).sort(),
    ).toEqual(['tool_failure:browser_click', 'tool_refused:browser_click']);
  });

  it('skips a cause the thread already has even when that flag was deleted', async () => {
    await seedRun('run-1');
    await broker.raiseAutomatic('run-1', auto('interrupted:quit'));
    const em = orm.em.fork();
    await em.nativeUpdate(
      AgentFlag,
      { runId: 'run-1' },
      { deletedAt: new Date() },
    );

    expect(
      await broker.raiseAutomatic('run-1', auto('interrupted:quit')),
    ).toBeNull();
  });

  it('names the member’s agent, model and answered call from its flag sink, and the run’s without one', async () => {
    await seedRun('run-1', { agentKind: 'claude', model: 'run-model' });
    disposers.push(
      broker.register('run-1', 'senior', {
        raiser: (caller) => ({
          memberId: 'senior',
          conversationId: caller === 'senior' ? null : 'conv-1',
          callId: 'call-7',
          agentKind: 'codex',
          model: 'gpt-5.5',
        }),
      }),
    );

    await broker.raiseAutomatic('run-1', auto('tool_refused:show_ui'));
    await broker.raiseAutomatic('run-1', {
      ...auto('interrupted:crash'),
      memberId: null,
      conversationId: null,
      caller: null,
    });

    const rows = await flags.forRun('run-1', 100);
    expect(
      rows.find((row) => row.autoCause === 'tool_refused:show_ui'),
    ).toMatchObject({
      memberId: 'senior',
      callId: 'call-7',
      agentKind: 'codex',
      model: 'gpt-5.5',
    });
    expect(
      rows.find((row) => row.autoCause === 'interrupted:crash'),
    ).toMatchObject({
      memberId: null,
      callId: null,
      agentKind: 'claude',
      model: 'run-model',
    });
  });

  it('writes nothing for a run that does not exist', async () => {
    expect(
      await broker.raiseAutomatic('run-gone', auto('interrupted:crash')),
    ).toBeNull();
    expect(await flags.forRun('run-gone', 100)).toEqual([]);
  });

  it('neither counts against an agent’s cap nor blocks its flag with the same summary', async () => {
    await seedRun('run-1');
    disposers.push(
      broker.register('run-1', 'senior', {
        raiser: () => ({
          memberId: 'senior',
          conversationId: null,
          callId: null,
          agentKind: null,
          model: null,
        }),
      }),
    );
    for (let index = 0; index < AGENT_FLAGS_PER_CONVERSATION; index += 1) {
      await broker.raiseAutomatic('run-1', {
        ...auto(`tool_failure:tool-${index}`),
        memberId: 'senior',
        conversationId: null,
        summary: index === 0 ? 'The browser timed out' : `auto ${index}`,
      });
    }

    const same = await agentFlag('run-1', 'The browser timed out');

    expect(same).toMatchObject({
      status: 'recorded',
      flagsLeft: AGENT_FLAGS_PER_CONVERSATION - 1,
    });
    const agentRow = (await flags.forRun('run-1', 100)).find(
      (row) => !row.automatic,
    );
    expect(agentRow).toMatchObject({ automatic: false, autoCause: null });
    expect(agentFlagWire(agentRow!).automatic).toBe(false);
  });
});
