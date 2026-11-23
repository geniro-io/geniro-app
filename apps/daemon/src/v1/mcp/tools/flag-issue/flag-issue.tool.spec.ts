import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import mikroOrmConfig from '../../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../../db/sqlite.driver';
import { AgentFlagDao } from '../../../agents/dao/agent-flag.dao';
import { ItemDao } from '../../../agents/dao/item.dao';
import { RunDao } from '../../../agents/dao/run.dao';
import {
  FlagBroker,
  type FlagRaiser,
} from '../../../agents/services/flag.broker';
import {
  clearSecrets,
  registerSecret,
} from '../../../diagnostics/utils/redact';
import { AgentFlag } from '../../../runs/entity/agent-flag.entity';
import { Item } from '../../../runs/entity/item.entity';
import { Run } from '../../../runs/entity/run.entity';
import type { McpCallContext } from '../../mcp.types';
import { gatedForHiddenLessons } from '../hidden-lessons-gate';
import { FlagIssueTool } from './flag-issue.tool';

describe('flag_issue', () => {
  let orm: MikroORM;
  let broker: FlagBroker;
  let tool: FlagIssueTool;
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
    tool = new FlagIssueTool(broker);
  });

  afterAll(async () => {
    await orm.close();
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    clearSecrets();
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

  const install = (
    runId: string,
    memberId: string,
    raiser: (caller: string) => FlagRaiser = (caller) => ({
      memberId,
      conversationId: caller === memberId ? null : caller,
      callId: null,
      agentKind: null,
      model: null,
    }),
  ) => {
    disposers.push(broker.register(runId, memberId, { raiser }));
  };

  const call = (
    runId: string,
    memberId: string,
    args: Record<string, unknown>,
    caller = memberId,
  ) =>
    tool.call(tool.name, args, {
      runId,
      memberId,
      conversationId: null,
      caller,
      requestId: 1,
      remote: false,
      whileCancellable: (run) => run(new AbortController().signal),
    } satisfies McpCallContext);

  const work = (summary: string) => ({
    cost: 'work',
    category: 'geniro_tool',
    summary,
    minutesLost: 15,
  });

  it('is listed only to a member whose pass installed a sink', async () => {
    await seedRun('run-1');
    const context = { runId: 'run-1', memberId: 'agent', conversationId: null };
    expect(tool.list(context)).toEqual([]);
    install('run-1', 'agent');
    expect(tool.list(context).map((entry) => entry.name)).toEqual([
      'flag_issue',
    ]);
  });

  it('stays listed in a hidden lessons chat, whose other tools are cut', async () => {
    install('run-lessons', 'agent');
    const gated = gatedForHiddenLessons(tool, {
      isHiddenLessons: () => true,
    });
    expect(
      gated
        .list({ runId: 'run-lessons', memberId: 'agent', conversationId: null })
        .map((entry) => entry.name),
    ).toEqual(['flag_issue']);
  });

  it('writes one row stamped from the run and the raising conversation, never from the arguments', async () => {
    await seedRun('run-team', {
      teamId: 'dev-team',
      projectId: 'project-1',
      title: 'Ship the export',
    });
    await seedItem('run-team', 7);
    install('run-team', 'senior', () => ({
      memberId: 'senior',
      conversationId: 'conv-2',
      callId: 'call-9',
      agentKind: 'claude',
      model: 'opus',
    }));

    const result = await call('run-team', 'senior', {
      cost: 'disagreement',
      category: 'geniro_instructions',
      summary: 'The user rejected the split proposal',
      detail: 'They wanted one PR.',
    });

    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^Flag F-[0-9a-f]{6} recorded\./);
    const [row, ...rest] = await flags.forRun('run-team', 100);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      runId: 'run-team',
      seq: 7,
      memberId: 'senior',
      conversationId: 'conv-2',
      callId: 'call-9',
      agentKind: 'claude',
      model: 'opus',
      teamSlug: 'dev-team',
      projectId: 'project-1',
      runKind: 'team',
      runTitle: 'Ship the export',
      cost: 'disagreement',
      category: 'geniro_instructions',
      minutesLost: null,
      summary: 'The user rejected the split proposal',
      detail: 'They wanted one PR.',
    });
    expect(text).toContain(row?.handle);
  });

  it('reads a chat’s agent and model from the run when the sink names none', async () => {
    await seedRun('run-chat', { agentKind: 'codex', model: 'gpt-5' });
    install('run-chat', 'agent');
    await call('run-chat', 'agent', work('A tool kept timing out'));
    const [row] = await flags.forRun('run-chat', 100);
    expect(row).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5',
      runKind: 'chat',
      minutesLost: 15,
    });
  });

  it('records a hidden lessons reflection under its own kind', async () => {
    await seedRun('run-lessons', {
      analysisSourceRunId: 'source',
      analysisPurpose: 'lessons',
    });
    install('run-lessons', 'agent');
    await call(
      'run-lessons',
      'agent',
      work('propose_lessons refused my batch'),
    );
    const [row] = await flags.forRun('run-lessons', 100);
    expect(row?.runKind).toBe('lessons');
  });

  it('refuses the same summary twice in one thread, whoever raises it', async () => {
    await seedRun('run-1');
    install('run-1', 'agent');
    install('run-1', 'other');
    await call('run-1', 'agent', work('The board tool lost my card'));

    const again = await call(
      'run-1',
      'other',
      work('  the board tool   lost my CARD '),
    );

    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toMatch(/^DUPLICATE_FLAG:/);
    expect(await flags.forRun('run-1', 100)).toHaveLength(1);
  });

  it('refuses an eleventh flag from one conversation and still takes another conversation’s', async () => {
    await seedRun('run-1');
    install('run-1', 'agent');
    for (let i = 1; i <= 10; i += 1) {
      const result = await call('run-1', 'agent', work(`Problem number ${i}`));
      expect(result.isError).toBe(false);
    }

    const eleventh = await call('run-1', 'agent', work('Problem number 11'));
    const otherConversation = await call(
      'run-1',
      'agent',
      work('Problem seen while answering a call'),
      'agent\u0000conv-7',
    );

    expect(eleventh.isError).toBe(true);
    expect(eleventh.content[0]?.text).toMatch(/^FLAG_LIMIT:/);
    expect(otherConversation.isError).toBe(false);
    expect(await flags.forRun('run-1', 100)).toHaveLength(11);
  });

  it('masks a registered secret in the summary, detail and run title before the write', async () => {
    await seedRun('run-1', { title: 'Deploy with sk-live-0123456789abcdef' });
    install('run-1', 'agent');
    registerSecret('sk-live-0123456789abcdef', 'launch token');
    await call('run-1', 'agent', {
      ...work('Tool echoed sk-live-0123456789abcdef back'),
      detail: 'Again: sk-live-0123456789abcdef',
    });
    const [row] = await flags.forRun('run-1', 100);
    expect(row?.summary).not.toContain('sk-live-0123456789abcdef');
    expect(row?.detail).not.toContain('sk-live-0123456789abcdef');
    expect(row?.runTitle).toMatch(/^Deploy with /);
    expect(row?.runTitle).not.toContain('sk-live-0123456789abcdef');
  });

  it('answers that nothing was recorded when no turn holds a sink', async () => {
    const result = await call('run-gone', 'agent', work('Lost'));
    expect(result.content[0]?.text).toBe(
      'Not recorded: no turn is running that could record it.',
    );
    expect(result.isError).toBe(true);
  });
});
