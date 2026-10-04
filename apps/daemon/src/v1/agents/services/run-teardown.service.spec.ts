import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type {
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
} from '../adapters/adapter.types';
import { CallContextDao } from '../dao/call-context.dao';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ArtifactStoreService } from './artifact-store.service';
import { AttachmentStoreService } from './attachment-store.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import { RunTeardownService } from './run-teardown.service';
import { SessionTranscriptsService } from './session-transcripts.service';

/**
 * The teardown's own spec, over REAL DAOs on a real in-memory schema.
 *
 * It exists because every table a run owns is enumerated by hand here — nothing
 * cascades — so the only thing standing between a new table and rows that
 * outlive their run is a line in `purge`. A table's rows are exactly what a
 * fake DAO cannot pin: the spies elsewhere assert that a call was MADE, and
 * this asserts that the rows are GONE.
 */
describe('RunTeardownService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let teardown: RunTeardownService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let callContextDao: CallContextDao;
  let removedArtifactRuns: string[];
  /** Every CLI transcript the teardown asked an adapter to delete. */
  let deletedTranscripts: (DeleteSessionTranscriptInput & { agent: string })[];
  /**
   * Every statement the ORM ran while {@link recording} was set — how the
   * transcript purge is observed NOT reading the rows it destroys, which no
   * table assertion can see (the rows are gone either way).
   */
  const statements: string[] = [];
  let recording = false;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, CallContext],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
        debug: ['query'],
        logger: (message) => {
          if (recording) {
            statements.push(message);
          }
        },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    removedArtifactRuns = [];
    deletedTranscripts = [];
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    callContextDao = new CallContextDao(em);
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
      {
        close: () => undefined,
        closeRun: () => undefined,
      } as unknown as AgentSessionRegistry,
      { revokeRun: () => undefined } as unknown as CallTokenRegistry,
      { forgetRun: () => undefined } as unknown as PartialStreamService,
      { removeRun: () => undefined } as unknown as AttachmentStoreService,
      // Recording, unlike the attachment store beside it: the artifact store is
      // a file store nothing else in this spec would notice being skipped, so
      // this is the only thing standing between a purge and a run's pages
      // outliving it on disk.
      {
        removeRun: (runId: string) => removedArtifactRuns.push(runId),
      } as unknown as ArtifactStoreService,
      { forget: () => undefined } as unknown as ItemSeqAllocator,
      // The REAL collector over the real node-state rows, so which sessions a
      // purge reaches is read from the table it is read from in production;
      // only the per-CLI delete is a recording double.
      new SessionTranscriptsService(nodeStateDao, {
        for: (agent: string) => ({
          deleteSessionTranscript: (
            input: DeleteSessionTranscriptInput,
          ): Promise<DeleteSessionTranscriptResult> => {
            deletedTranscripts.push({ ...input, agent });
            return Promise.resolve({ deleted: true });
          },
        }),
      } as unknown as AgentAdapterRegistry),
    );
  });

  /** A run holding one node, two of its call threads, and a transcript row. */
  const seedRun = async (runId: string): Promise<void> => {
    await runDao.create({ id: runId, agentKind: 'claude', cwd: '/work' });
    await nodeStateDao.createPending(runId, 'node-a');
    await callContextDao.rememberContext(
      runId,
      'call-1',
      'node-a',
      4200,
      200000,
    );
    await callContextDao.rememberContext(
      runId,
      'call-2',
      'node-a',
      91000,
      200000,
    );
  };

  it('destroys the per-call context rows of the run it deletes', async () => {
    await seedRun('run-a');
    expect(await callContextDao.listByRun('run-a')).toHaveLength(2);

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await callContextDao.listByRun('run-a')).toHaveLength(0);
  });

  it('leaves another run’s per-call context rows standing', async () => {
    await seedRun('run-a');
    await seedRun('run-b');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await callContextDao.listByRun('run-a')).toHaveLength(0);
    expect(await callContextDao.listByRun('run-b')).toHaveLength(2);
  });

  it('destroys the run’s node states and the run row alongside them', async () => {
    await seedRun('run-a');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await nodeStateDao.listByRun('run-a')).toHaveLength(0);
    expect(await runDao.getById('run-a', orm.em.fork())).toBeNull();
  });

  it('drops the run’s published artifacts, which nothing else would reach', async () => {
    // The pages live as files under the artifacts root, so no table assertion
    // above can see them: without this call a deleted run's artifacts stay on
    // disk for the life of the install, unreachable and unreferenced.
    await seedRun('run-a');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(removedArtifactRuns).toEqual(['run-a']);
  });

  describe('the transcript purge', () => {
    /** Seed `count` transcript rows on a run, each carrying a real payload. */
    const seedTranscript = async (
      runId: string,
      count: number,
    ): Promise<void> => {
      for (let seq = 0; seq < count; seq += 1) {
        await itemDao.create({
          runId,
          seq,
          kind: 'tool_result',
          payload: JSON.stringify({ output: 'x'.repeat(2_000) }),
        });
      }
    };

    /** Everything a purge of `runId` said to the `items` table. */
    const itemStatementsOf = async (runId: string): Promise<string[]> => {
      statements.length = 0;
      recording = true;
      try {
        await teardown.purge(orm.em.fork(), runId, undefined);
      } finally {
        recording = false;
      }
      return statements.filter((sql) => sql.includes('`items`'));
    };

    it('destroys the transcript without reading it back first', async () => {
      // The generic hard delete hydrated every row, payload and all, only to
      // hand it to `em.remove` — measured at ~103MB of heap for a 20,000-row
      // run, and the busiest real threads run past 30,000. The observable is
      // the SQL itself: a purge that READS the transcript selects from it.
      await seedRun('run-a');
      await seedTranscript('run-a', 3);

      const sql = await itemStatementsOf('run-a');

      expect(sql.filter((line) => /\bselect\b/i.test(line))).toEqual([]);
      expect(sql).toHaveLength(1);
      expect(await itemDao.getAll({ runId: 'run-a' })).toHaveLength(0);
    });

    it('reaches a transcript row that was soft-deleted', async () => {
      // A native delete is filtered like a read, so without the `softDelete`
      // filter switched off a soft-deleted row would survive its run as an
      // orphan nothing can reach or remove.
      await seedRun('run-a');
      await seedTranscript('run-a', 2);
      await orm.em
        .fork()
        .nativeUpdate(
          Item,
          { runId: 'run-a', seq: 0 },
          { deletedAt: new Date() },
        );

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(
        await orm.em
          .fork()
          .find(Item, { runId: 'run-a' }, { filters: { softDelete: false } }),
      ).toHaveLength(0);
    });

    it('leaves another run’s transcript standing', async () => {
      await seedRun('run-a');
      await seedRun('run-b');
      await seedTranscript('run-a', 2);
      await seedTranscript('run-b', 2);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(await itemDao.getAll({ runId: 'run-b' })).toHaveLength(2);
    });
  });

  it('drops only the deleted run’s artifacts', async () => {
    await seedRun('run-a');
    await seedRun('run-b');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(removedArtifactRuns).not.toContain('run-b');
  });
  describe('the CLI’s own transcripts', () => {
    /** A chat run holding two CLI sessions — a compaction replaced the first. */
    const seedChat = async (
      runId: string,
      archived: boolean,
      sessions: string[],
    ): Promise<Run> => {
      const run = await runDao.create({
        id: runId,
        agentKind: 'claude',
        cwd: '/work',
        configDir: '/profiles/work',
        archivedAt: archived ? new Date() : null,
      });
      for (const sessionId of sessions) {
        await nodeStateDao.saveSessionId(runId, 'agent', sessionId);
      }
      return run;
    };

    it('deletes every session an ARCHIVED chat held, under its own profile', async () => {
      const run = await seedChat('run-a', true, ['s-1', 's-2']);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(
        deletedTranscripts.map(({ agent, sessionId, configDir }) => ({
          agent,
          sessionId,
          configDir,
        })),
      ).toEqual([
        { agent: 'claude', sessionId: 's-1', configDir: '/profiles/work' },
        { agent: 'claude', sessionId: 's-2', configDir: '/profiles/work' },
      ]);
      // The moment the run began is what lets each CLI keep a conversation
      // that was imported from the user's own terminal.
      expect(deletedTranscripts[0]?.runCreatedAt.getTime()).toBe(
        run.createdAt.getTime(),
      );
    });

    it('leaves the transcripts of a run that was never archived', async () => {
      // A failed task start and a workflow builder's chat purge their runs too,
      // and neither is the user deleting a conversation.
      await seedChat('run-a', false, ['s-1']);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(deletedTranscripts).toEqual([]);
    });

    it('keeps a session another run still names', async () => {
      await seedChat('run-a', true, ['shared', 'own']);
      await seedChat('run-b', false, ['shared']);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(deletedTranscripts.map((entry) => entry.sessionId)).toEqual([
        'own',
      ]);
    });

    it('deletes a workflow node’s sessions under the profile its snapshot names', async () => {
      await runDao.create({
        id: 'run-w',
        workflowId: 'dev-team',
        cwd: '/work',
        archivedAt: new Date(),
        workflowSnapshot: JSON.stringify({
          nodes: [
            { id: 'manager', kind: 'agent', configDir: '/profiles/alt' },
            { id: 'qa', kind: 'agent' },
          ],
        }),
      });
      await nodeStateDao.saveSessionId('run-w', 'manager', 'm-1');
      await nodeStateDao.saveSessionId('run-w', 'qa', 'q-1');

      const em = orm.em.fork();
      for (const [nodeId, agentKind] of [
        ['manager', 'claude'],
        ['qa', 'cursor-agent'],
      ] as const) {
        await em.nativeUpdate(
          NodeState,
          { runId: 'run-w', nodeId },
          { agentKind },
        );
      }

      await teardown.purge(orm.em.fork(), 'run-w', undefined);

      expect(
        deletedTranscripts
          .map(({ agent, sessionId, configDir }) => ({
            agent,
            sessionId,
            configDir,
          }))
          .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      ).toEqual([
        { agent: 'claude', sessionId: 'm-1', configDir: '/profiles/alt' },
        { agent: 'cursor-agent', sessionId: 'q-1', configDir: null },
      ]);
    });
  });
});
