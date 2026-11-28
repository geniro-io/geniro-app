import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { claudeToolCallMetric } from '../../agents/adapters/claude/utils/claude-mcp-tool-name.utils';
import { codexToolCallMetric } from '../../agents/adapters/codex/utils/codex-items.utils';
import { cursorToolCallMetric } from '../../agents/adapters/cursor-acp/utils/cursor-tool-metric.utils';
import type { ItemWire } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { AgentKind, ItemKind } from '../../runs/runs.types';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { UsageCounterDao } from '../dao/usage-counter.dao';
import { ToolCallEvent } from '../entity/tool-call-event.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageCounter } from '../entity/usage-counter.entity';
import { UsageCounterBackfill } from '../entity/usage-counter-backfill.entity';
import { UsageSubject } from '../entity/usage-subject.entity';
import { ThreadMetricsLedgerService } from '../services/thread-metrics-ledger.service';
import { ToolCallLogRetentionService } from '../services/tool-call-log-retention.service';
import { ToolUsageService } from '../services/tool-usage.service';
import { UsageCounterService } from '../services/usage-counter.service';
import { UsageCounterBackfillService } from '../services/usage-counter-backfill.service';
import { UsageObserverService } from '../services/usage-observer.service';
import { UsageRegistryService } from '../services/usage-registry.service';
import { UsageRunFactsService } from '../services/usage-run-facts.service';

/** Each CLI's own tool-name reading, as its adapter answers `toolCallMetric`. */
const METRICS: Record<
  AgentKind,
  (name: string, kind: string | null) => { tool: string; server: string | null }
> = {
  claude: claudeToolCallMetric,
  codex: codexToolCallMetric,
  'cursor-agent': cursorToolCallMetric,
};

/** The ledger service over an in-memory database, with helpers to feed it rows. */
export async function metricLedgerDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [
        Run,
        Item,
        NodeState,
        Goal,
        Project,
        ToolCallEvent,
        UsageActivity,
        UsageCounter,
        UsageSubject,
        UsageCounterBackfill,
      ],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const adapterOf = (kind: AgentKind) => ({
    toolCallMetric: (name: string, toolKind: string | null) =>
      METRICS[kind](name, toolKind),
  });
  const adapters = {
    for: adapterOf,
    all: () =>
      new Map(
        (Object.keys(METRICS) as AgentKind[]).map((kind) => [
          kind,
          adapterOf(kind),
        ]),
      ),
  } as unknown as AgentAdapterRegistry;
  const ledger = new MetricLedgerDao(em);
  const bus = new AgentEventBus();
  const runDao = new RunDao(em);
  const counterDao = new UsageCounterDao(em);
  const facts = new UsageRunFactsService(em, bus, runDao, new NodeStateDao(em));
  facts.onModuleInit();
  const counters = new UsageCounterService(counterDao);
  const registry = new UsageRegistryService(counterDao);
  const backfill = new UsageCounterBackfillService(em, counterDao, runDao);
  const service = new ThreadMetricsLedgerService(
    em,
    bus,
    new ItemDao(em),
    adapters,
    ledger,
    facts,
    counters,
    backfill,
  );
  const observer = new UsageObserverService(
    em,
    bus,
    adapters,
    facts,
    counters,
    registry,
  );
  const toolUsage = new ToolUsageService(
    em,
    counterDao,
    counters,
    registry,
    backfill,
    new ProjectDao(em),
  );
  const retention = new ToolCallLogRetentionService(counterDao, backfill);
  const seedRun = async (id: string, extra: Partial<Run> = {}) => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Run(), {
        id,
        status: 'running',
        createdAt: new Date('2026-11-01T09:00:00.000Z'),
        ...extra,
      } as Run),
    );
    await fork.flush();
  };
  const seedMember = async (
    runId: string,
    memberId: string,
    agent: AgentKind,
  ) => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new NodeState(), {
        runId,
        memberId,
        status: 'completed',
        agentKind: agent,
      } as NodeState),
    );
    await fork.flush();
  };
  let next = 1;
  /** Write a row to `items` and hand it to the ledger as the bus would. */
  const row = async (
    runId: string,
    kind: ItemKind,
    payload: Record<string, unknown>,
    at: string,
    memberId: string | null = null,
    inCall: string | null = null,
    role: ItemWire['role'] = null,
  ): Promise<ItemWire> => {
    const seq = next++;
    const fork = em.fork();
    const entity = fork.create(Item, {
      runId,
      seq,
      kind,
      role,
      memberId,
      payload: JSON.stringify(payload),
      createdAt: new Date(at),
      inCall,
    } as Item);
    await fork.flush();
    return {
      id: entity.id,
      runId,
      memberId,
      seq,
      kind,
      role,
      payload,
      createdAt: at,
      inCall,
    };
  };
  const feed = async (
    runId: string,
    kind: ItemKind,
    payload: Record<string, unknown>,
    at: string,
    memberId: string | null = null,
    inCall: string | null = null,
    role: ItemWire['role'] = null,
  ): Promise<ItemWire> => {
    const item = await row(runId, kind, payload, at, memberId, inCall, role);
    await service.observe({ runId, item });
    await observer.observe({ runId, item });
    return item;
  };
  return {
    orm,
    em,
    bus,
    ledger,
    service,
    counterDao,
    counters,
    registry,
    backfill,
    observer,
    toolUsage,
    retention,
    runDao,
    seedRun,
    seedMember,
    row,
    feed,
  };
}
