import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { NodeStateDao } from './node-state.dao';

/**
 * Real-driver DAO spec (see item.dao.spec for the harness rationale): pins the
 * F39 agent-kind stamp — the terminal mirror resolves a HISTORICAL run's CLI
 * from this column, so it must round-trip and must survive later status
 * transitions that don't carry it.
 */
describe('NodeStateDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: NodeStateDao;

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
    dao = new NodeStateDao(orm.em.fork());
  });

  it('stamps agentKind at the running transition and round-trips it', async () => {
    await dao.createPending('run-1', 'node-a');
    await dao.setStatus('run-1', 'node-a', {
      status: 'running',
      startedAt: 111,
      agentKind: 'cursor-agent',
    });

    const row = await dao.getByRunNode('run-1', 'node-a');
    expect(row?.status).toBe('running');
    expect(row?.agentKind).toBe('cursor-agent');
  });

  it('a later transition WITHOUT agentKind leaves the stamp untouched', async () => {
    await dao.setStatus('run-1', 'node-a', {
      status: 'running',
      agentKind: 'claude',
    });
    await dao.setStatus('run-1', 'node-a', { status: 'completed', endedAt: 5 });

    const row = await dao.getByRunNode('run-1', 'node-a');
    expect(row?.status).toBe('completed');
    expect(row?.agentKind).toBe('claude');
  });

  it('a row created without a stamp reads null (the legacy YAML-fallback marker)', async () => {
    await dao.createPending('run-1', 'node-a');
    const row = await dao.getByRunNode('run-1', 'node-a');
    expect(row?.agentKind).toBeNull();
  });
});
