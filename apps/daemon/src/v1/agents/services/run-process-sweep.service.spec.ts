import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { KeptProcessRoot } from '../chat.types';
import { RunDao } from '../dao/run.dao';
import {
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  type ScannedProcess,
} from '../utils/run-process-scan';
import { nodeSessionKey } from '../utils/session-keys';
import type { AgentSessionRegistry } from './agent-session.registry';
import { RunProcessAttribution } from './run-process-attribution.service';
import type { RunProcessReaper } from './run-process-reaper.service';
import {
  RUN_PROCESS_SWEEP_EVERY_MS,
  RUN_PROCESS_SWEEP_FIRST_MS,
  RunProcessSweep,
} from './run-process-sweep.service';

const OWNER = 'aaaaaaaaaaaaaaaa';
const SELF = 900;
const UID = 501;

const tagged = (pid: number, runId: string, ppid = 1): ScannedProcess => ({
  pid,
  ppid,
  pgid: pid,
  uid: UID,
  tty: null,
  startedAt: 1_000,
  args: `node ${runId}.js`,
  env: `${RUN_ID_ENV}=${runId} ${RUN_OWNER_ENV}=${OWNER}`,
});

/**
 * Over a REAL in-memory schema: which runs read as gone is the database's
 * answer to the sweep's query, and a double that returned what it was told
 * could not catch that query asking the wrong thing.
 */
describe('RunProcessSweep (in-memory sqlite)', () => {
  let orm: MikroORM;
  let runDao: RunDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, CallContext],
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
    runDao = new RunDao(orm.em.fork());
  });

  function sweep(
    rows: ScannedProcess[] | null,
    options: {
      roots?: () => KeptProcessRoot[];
      runDao?: RunDao;
      scan?: () => Promise<ScannedProcess[] | null>;
    } = {},
  ) {
    const sessions = {
      processRoots: () => options.roots?.() ?? [],
    } as unknown as AgentSessionRegistry;
    const reaped: string[] = [];
    const conditional: boolean[] = [];
    const reaper = {
      reapInBackground: (runId: string, onlyIfStillGone = false) => {
        reaped.push(runId);
        conditional.push(onlyIfStillGone);
      },
      settled: () => Promise.resolve(),
    } as unknown as RunProcessReaper;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const scan = vi.fn(options.scan ?? (() => Promise.resolve(rows)));
    const attribution = new RunProcessAttribution(OWNER, {
      scan,
      selfPid: SELF,
      uid: UID,
    });
    return {
      reaped,
      conditional,
      logger,
      scan,
      subject: new RunProcessSweep(
        orm.em,
        options.runDao ?? runDao,
        sessions,
        reaper,
        attribution,
        { logger },
      ),
    };
  }

  it('stops what deleted and archived threads left running, and nothing of a live one', async () => {
    const live = await runDao.create({ status: 'completed' });
    const archived = await runDao.create({ status: 'completed' });
    await runDao.updateById(archived.id, { archivedAt: new Date() });
    const { subject, reaped, conditional } = sweep([
      tagged(10, live.id),
      tagged(20, 'run-deleted'),
      tagged(30, archived.id),
    ]);
    const gone = await subject.sweep();
    expect(gone.sort()).toEqual(['run-deleted', archived.id].sort());
    expect(reaped.sort()).toEqual(['run-deleted', archived.id].sort());
    // Its verdict is a reading old: the reaper asks again before a signal.
    expect(conditional).toEqual([true, true]);
  });

  it('never sweeps a run the registry holds a process for by the time of its scan', async () => {
    // Not a row yet, or not a row at all — but its agent is running now. Held
    // only from the scan on: a check made before it would sweep the agent.
    let scanned = false;
    const root: KeptProcessRoot = {
      key: nodeSessionKey('run-new', 'dev'),
      agent: 'claude',
      cwd: '/p',
      pid: 10,
    };
    const { subject, reaped } = sweep([], {
      scan: () => {
        scanned = true;
        return Promise.resolve([tagged(10, 'run-new')]);
      },
      roots: () => (scanned ? [root] : []),
    });
    expect(await subject.sweep()).toEqual([]);
    expect(reaped).toEqual([]);
  });

  it('sweeps nothing when the process table cannot be read', async () => {
    const { subject, reaped, logger } = sweep(null);
    expect(await subject.sweep()).toEqual([]);
    expect(reaped).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('sweeps nothing when the database cannot be read', async () => {
    const failing = {
      getAll: () => Promise.reject(new Error('SQLITE_BUSY')),
    } as unknown as RunDao;
    const { subject, reaped } = sweep([tagged(10, 'run-x')], {
      runDao: failing,
    });
    await expect(subject.sweep()).rejects.toThrow('SQLITE_BUSY');
    expect(reaped).toEqual([]);
  });

  it('joins a sweep still running instead of starting a second', async () => {
    const { subject, reaped } = sweep([tagged(20, 'run-gone')]);
    await Promise.all([subject.sweep(), subject.sweep()]);
    expect(reaped).toEqual(['run-gone']);
  });

  describe('its schedule', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sweeps once shortly after boot, then on every interval, and stops at shutdown', async () => {
      const { subject, scan } = sweep([]);
      subject.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_FIRST_MS - 1);
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_EVERY_MS);
      expect(scan).toHaveBeenCalledTimes(2);
      subject.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_EVERY_MS * 3);
      expect(scan).toHaveBeenCalledTimes(2);
    });

    it('reports a failed background sweep as a warning instead of rejecting', async () => {
      const { subject, logger } = sweep(null, {
        scan: () => Promise.reject(new Error('boom')),
      });
      subject.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_FIRST_MS);
      expect(logger.warn).toHaveBeenCalledWith(
        'could not sweep leftover processes: boom',
      );
      subject.onApplicationShutdown();
    });
  });
});
