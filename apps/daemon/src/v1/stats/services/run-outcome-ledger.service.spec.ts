import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
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

import type { ItemWire, RunOutcomePayload } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { RunOutcomeLedgerService } from './run-outcome-ledger.service';

const payload = (
  overrides: Partial<RunOutcomePayload> = {},
): RunOutcomePayload => ({
  prOwner: 'acme',
  prRepo: 'platform',
  prNumber: 87,
  prUrl: 'https://github.com/acme/platform/pull/87',
  draft: true,
  reviewRounds: 0,
  acceptance: 'not_yet',
  questionsAsked: 0,
  workflowSlug: 'dev-team',
  nodeId: 'manager',
  conversationId: null,
  ...overrides,
});

interface StoredItem {
  runId: string;
  seq: number;
  payload: string;
  createdAt: Date;
}

/**
 * The copy of each recorded outcome into the ledger that outlives the run: the live
 * subscription and the boot sweep, through a real bus and the real DAO.
 */
describe('RunOutcomeLedgerService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: UsageActivityDao;
  let bus: AgentEventBus;
  let items: StoredItem[];
  let service: RunOutcomeLedgerService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [UsageActivity],
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
    dao = new UsageActivityDao(orm.em.fork());
    bus = new AgentEventBus();
    items = [];
    const itemDao = {
      runOutcomeRows: async () => items.map((item) => ({ ...item })),
    } as unknown as ItemDao;
    service = new RunOutcomeLedgerService(orm.em, bus, itemDao, dao);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const publish = (
    seq: number,
    kind: ItemWire['kind'],
    body: unknown,
    runId = 'run-1',
  ): void => {
    bus.publish({
      runId,
      item: {
        id: `item-${seq}`,
        runId,
        nodeId: 'manager',
        seq,
        kind,
        role: null,
        payload: body,
        createdAt: '2026-10-20T10:00:00.000Z',
        inCall: null,
      } as ItemWire,
    });
  };

  describe('live', () => {
    beforeEach(() => {
      // The boot sweep runs too; with no stored items it writes nothing.
      service.onModuleInit();
    });

    it('copies a recorded outcome into the ledger as it is announced', async () => {
      publish(12, 'run_outcome', payload({ acceptance: 'accepted' }));

      await vi.waitFor(async () =>
        expect(await dao.runOutcomes({ runIds: ['run-1'] })).toHaveLength(1),
      );
      expect(await dao.runOutcomes({ runIds: ['run-1'] })).toEqual([
        expect.objectContaining({
          sourceSeq: 12,
          prNumber: 87,
          acceptance: 'accepted',
          workflowSlug: 'dev-team',
          occurredAt: new Date('2026-10-20T10:00:00.000Z'),
        }),
      ]);
    });

    it('copies nothing for any other row, and warns for an outcome it cannot read', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      publish(3, 'team_note', { kind: 'fact', text: 'x' });
      publish(4, 'run_outcome', { ...payload(), acceptance: 'merged' });
      // A later readable outcome lands, so the two before it were handled.
      publish(5, 'run_outcome', payload());
      await vi.waitFor(async () =>
        expect(await dao.runOutcomes({})).toHaveLength(1),
      );

      expect(await dao.runOutcomes({})).toMatchObject([{ sourceSeq: 5 }]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('warns and carries on when the ledger write fails', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      vi.spyOn(dao, 'upsertRunOutcome').mockRejectedValueOnce(
        new Error('database is locked'),
      );

      publish(12, 'run_outcome', payload());

      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      expect(warn.mock.calls[0]?.[0]).toContain('database is locked');
    });
  });

  it('logs a failed boot sweep instead of throwing it into the bus subscription', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    vi.spyOn(service, 'sweep').mockRejectedValueOnce(new Error('disk I/O'));

    expect(() => service.onModuleInit()).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0]?.[0]).toContain('outcome ledger sweep failed');
  });

  describe('sweep', () => {
    const stored = (
      seq: number,
      overrides: Partial<RunOutcomePayload> = {},
      runId = 'run-1',
    ): StoredItem => ({
      runId,
      seq,
      payload: JSON.stringify(payload(overrides)),
      createdAt: new Date(
        `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`,
      ),
    });

    it("copies each pull request's newest outcome the ledger lacks, once", async () => {
      items = [
        stored(5),
        stored(9, { acceptance: 'accepted', reviewRounds: 1 }),
        stored(7, {
          prNumber: 90,
          prUrl: 'https://github.com/acme/platform/pull/90',
        }),
        stored(3, {}, 'run-2'),
        { runId: 'run-3', seq: 1, payload: '{not json', createdAt: new Date() },
      ];

      expect(await service.sweep()).toBe(3);
      expect(await service.sweep()).toBe(0);
      expect(
        (await dao.runOutcomes({})).map(
          (row) =>
            `${row.runId}#${row.prNumber}@${row.sourceSeq}:${row.acceptance}`,
        ),
      ).toEqual([
        'run-2#87@3:not_yet',
        'run-1#90@7:not_yet',
        'run-1#87@9:accepted',
      ]);
    });

    it('moves a stale copy forward and leaves a newer one where it is', async () => {
      await dao.upsertRunOutcome({
        runId: 'run-1',
        sourceSeq: 5,
        occurredAt: new Date('2026-10-20T09:00:00.000Z'),
        workflowSlug: 'dev-team',
        prOwner: 'acme',
        prRepo: 'platform',
        prNumber: 87,
        prUrl: 'https://github.com/acme/platform/pull/87',
        draft: true,
        reviewRounds: 0,
        acceptance: 'not_yet',
        questionsAsked: 0,
      });
      await dao.upsertRunOutcome({
        runId: 'run-2',
        sourceSeq: 30,
        occurredAt: new Date('2026-10-20T09:00:00.000Z'),
        workflowSlug: 'dev-team',
        prOwner: 'acme',
        prRepo: 'platform',
        prNumber: 87,
        prUrl: 'https://github.com/acme/platform/pull/87',
        draft: false,
        reviewRounds: 2,
        acceptance: 'accepted',
        questionsAsked: 4,
      });
      items = [
        stored(9, { acceptance: 'changes_requested' }),
        stored(12, {}, 'run-2'),
      ];

      expect(await service.sweep()).toBe(1);
      expect(
        (await dao.runOutcomes({}))
          .map((row) => `${row.runId}@${row.sourceSeq}:${row.acceptance}`)
          .sort(),
      ).toEqual(['run-1@9:changes_requested', 'run-2@30:accepted']);
    });
  });
});
