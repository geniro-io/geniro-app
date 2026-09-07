import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallTokenRegistry } from '../../../auth/call-token.registry';
import { CallContextDao } from '../../agents/dao/call-context.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import type { AttachmentStoreService } from '../../agents/services/attachment-store.service';
import type { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import type { PartialStreamService } from '../../agents/services/partial-stream.service';
import type { ProcessRegistry } from '../../agents/services/process-registry';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageEvent } from '../entity/usage-event.entity';

/**
 * The one behaviour the whole usage ledger exists for: deleting a chat must NOT
 * take its spend with it.
 *
 * Driven against the REAL `RunTeardownService` — the service that would break
 * it — rather than asserting the stats module's own intent back to itself. It
 * lives here, in the stats module, because this module is what silently loses
 * meaning if the teardown ever starts clearing `usage_events`: the page would
 * go on rendering, with lifetime totals that quietly shrink every time someone
 * tidies up a conversation.
 */
describe('usage ledger retention across a run delete', () => {
  let orm: MikroORM;
  let teardown: RunTeardownService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let callContextDao: CallContextDao;
  let usageDao: UsageEventDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, CallContext, UsageEvent],
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
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    callContextDao = new CallContextDao(em);
    usageDao = new UsageEventDao(em);
    teardown = new RunTeardownService(
      itemDao,
      nodeStateDao,
      callContextDao,
      runDao,
      new AgentEventBus(),
      // The in-memory planes a delete also clears. Stubbed because none of them
      // touches the database, and what this spec is about is which TABLES the
      // purge reaches.
      { cancel: () => false } as unknown as ProcessRegistry,
      { close: () => undefined } as unknown as AgentSessionRegistry,
      { revokeRun: () => undefined } as unknown as CallTokenRegistry,
      { forgetRun: () => undefined } as unknown as PartialStreamService,
      { removeRun: () => undefined } as unknown as AttachmentStoreService,
      { forget: () => undefined } as unknown as ItemSeqAllocator,
    );
  });

  it('destroys the run’s transcript but leaves its recorded spend standing', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude', cwd: '/work' });
    await itemDao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'turn_complete',
      payload: JSON.stringify({ usage: { costUsd: 2.5 } }),
    });
    await nodeStateDao.create({ runId: 'run-a', nodeId: 'main' });
    await usageDao.recordOnce({
      runId: 'run-a',
      nodeId: null,
      seq: 0,
      occurredAt: new Date(2026, 7, 10, 9),
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work',
      workflowName: null,
      costUsd: 2.5,
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    // Everything the teardown owns is gone…
    expect(await runDao.getAll({})).toHaveLength(0);
    expect(await itemDao.getAll({})).toHaveLength(0);
    expect(await nodeStateDao.getAll({})).toHaveLength(0);
    // …and the money is still on the books. A `usage_events` line added to
    // `RunTeardownService.purge` — or an FK that made the rows cascade — fails
    // exactly here.
    const ledger = await usageDao.getAll({});
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      runId: 'run-a',
      costUsd: 2.5,
      agentKind: 'claude',
      cwd: '/work',
    });
  });

  it('keeps the deleted run’s spend inside the reported period', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await usageDao.recordOnce({
      runId: 'run-a',
      nodeId: null,
      seq: 0,
      occurredAt: new Date(2026, 7, 10, 9),
      agentKind: 'claude',
      model: null,
      cwd: null,
      workflowName: null,
      costUsd: 2.5,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    // The range query is what the page actually calls, so the retention has to
    // hold THERE and not merely in the table — a lifetime total that dropped
    // $2.50 the moment a chat was tidied away is the failure being prevented.
    const rows = await usageDao.inRange(
      new Date(2026, 7, 10),
      new Date(2026, 7, 11),
    );
    expect(rows.map((row) => row.costUsd)).toEqual([2.5]);
  });
});
