import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  ItemWire,
  RecommendationMarks,
  RecommendationsPayload,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import type { Team } from '../../teams/teams.types';
import { teamVersionOf } from '../../teams/utils/team-version';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { TeamRecommendation } from '../entity/team-recommendation.entity';
import { filedRecommendationsOf } from '../utils/recommendation-ledger';
import { RecommendationLedgerService } from './recommendation-ledger.service';

const LIBRARY: Team = teamOf([member('dev')], { name: 'Dev Team' });

function card(ids: string[]): RecommendationsPayload {
  return {
    sourceRunId: 'newest',
    sourceKind: 'team',
    timing: null,
    items: ids.map((id) => ({
      id,
      target: id.startsWith('W-') ? 'team' : 'repo',
      territory: 'process',
      kind: 'model',
      location: 'dev',
      title: `Title of ${id}`,
      change: `change for ${id}`,
      evidence: [{ runId: 'newest', seq: 4, quote: 'slow' }],
      rootCause: 'the reviewer runs the largest model',
      impact:
        id === 'W-1'
          ? {
              minutesSaved: 4,
              costSavedUsd: 0.6,
              basis: 'turn spans',
              confidence: 3,
              outcome: 'reviewer 9m → 5m per run',
            }
          : { minutesSaved: 4, basis: 'turn spans', confidence: 3 },
      risk: { level: 'low', note: 'none' },
    })),
  };
}

type ChatRun = Pick<Run, 'id' | 'analysisTeamSlug' | 'editsTeamSlug'>;

interface StoredRow {
  seq: number;
  kind: string;
  role: string | null;
  createdAt: Date;
  payload: string;
}

/**
 * The copy of a team chat's recommendations — the cards, the Applies and the
 * marks — into the ledger that outlives the chat, live off a real bus and by the
 * boot sweep, through the real DAO.
 */
describe('RecommendationLedgerService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: TeamRecommendationDao;
  let bus: AgentEventBus;
  let chats: Map<string, ChatRun>;
  let stored: Map<string, StoredRow[]>;
  let service: RecommendationLedgerService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [TeamRecommendation],
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
    dao = new TeamRecommendationDao(orm.em.fork());
    bus = new AgentEventBus();
    chats = new Map([
      [
        'analysis-1',
        {
          id: 'analysis-1',
          analysisTeamSlug: 'dev-team',
          editsTeamSlug: null,
        },
      ],
      [
        'builder-1',
        {
          id: 'builder-1',
          analysisTeamSlug: null,
          editsTeamSlug: 'dev-team',
        },
      ],
      [
        'plain-chat',
        {
          id: 'plain-chat',
          analysisTeamSlug: null,
          editsTeamSlug: null,
        },
      ],
    ]);
    stored = new Map();
    service = new RecommendationLedgerService(
      orm.em,
      bus,
      {
        getById: (id: string) => Promise.resolve(chats.get(id) ?? null),
        teamRecommendationChats: () =>
          Promise.resolve(
            [...chats.values()].filter(
              (chat) =>
                chat.analysisTeamSlug !== null || chat.editsTeamSlug !== null,
            ),
          ),
      } as unknown as RunDao,
      {
        rowsOfKinds: (runId: string) =>
          Promise.resolve(
            (stored.get(runId) ?? []).filter((row) => row.kind !== 'message'),
          ),
        userMessagesInOrder: (runId: string) =>
          Promise.resolve(
            (stored.get(runId) ?? []).filter((row) => row.kind === 'message'),
          ),
      } as unknown as ItemDao,
      dao,
      {
        get: () => Promise.resolve({ slug: 'dev-team', team: LIBRARY }),
      } as unknown as TeamStoreService,
    );
  });

  function publish(
    runId: string,
    seq: number,
    kind: ItemWire['kind'],
    payload: unknown,
    role: string | null = null,
    at = `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`,
  ): void {
    bus.publish({
      runId,
      item: {
        id: `${runId}-${seq}`,
        runId,
        memberId: null,
        seq,
        kind,
        role,
        payload,
        createdAt: at,
        inCall: null,
      } as ItemWire,
    });
  }

  describe('live', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

    it("files a team analysis's card with the library's version, then what the user selected and how each item was marked", async () => {
      publish('analysis-1', 5, 'recommendations', card(['W-1', 'W-2', 'R-1']));
      publish(
        'analysis-1',
        7,
        'message',
        { text: 'apply', apply: { cardSeq: 5, ids: ['W-1', 'R-1'] } },
        'user',
      );
      const marks: RecommendationMarks = {
        cardSeq: 5,
        outcomes: [
          { id: 'W-1', status: 'applied', backup: '.backups/x.yaml' },
          { id: 'R-1', status: 'failed', note: 'the file moved' },
        ],
      };
      publish('analysis-1', 9, 'recommendation_outcome', marks);
      await service.settled();

      const rows = await dao.rowsOf('dev-team');
      expect(
        rows.map((row) => [
          row.itemId,
          row.selectedAt !== null,
          row.outcome,
          row.outcomeNote,
        ]),
      ).toEqual([
        ['W-1', true, 'applied', null],
        ['W-2', false, null, null],
        ['R-1', true, 'failed', 'the file moved'],
      ]);
      expect(rows[0]).toMatchObject({
        chatRunId: 'analysis-1',
        chatKind: 'analysis',
        cardSeq: 5,
        filedAt: new Date('2026-10-20T10:00:05.000Z'),
        libraryVersion: teamVersionOf(LIBRARY),
        title: 'Title of W-1',
        change: 'change for W-1',
        rootCause: 'the reviewer runs the largest model',
        minutesSaved: 4,
        costSavedUsd: 0.6,
        expectedOutcome: 'reviewer 9m → 5m per run',
        confidence: 3,
        risk: 'low',
        outcomeSeq: 9,
      });
      expect(rows[1]).toMatchObject({
        costSavedUsd: null,
        expectedOutcome: null,
      });
    });

    it("files a builder chat's card under the team it edits", async () => {
      publish('builder-1', 3, 'recommendations', card(['W-1']));
      await service.settled();

      expect(await dao.rowsOf('dev-team')).toEqual([
        expect.objectContaining({
          chatRunId: 'builder-1',
          chatKind: 'builder',
        }),
      ]);
    });

    it('files nothing for a chat that is not about a team, nor for a message that applies nothing', async () => {
      publish('plain-chat', 3, 'recommendations', card(['R-1']));
      publish('analysis-1', 4, 'message', { text: 'thanks' }, 'user');
      await service.settled();

      expect(await dao.rowsOf('dev-team')).toEqual([]);
    });

    it('keeps the newest mark of an item whichever order two marks arrive in', async () => {
      publish('analysis-1', 5, 'recommendations', card(['W-1']));
      await service.settled();
      await dao.markOutcome(
        'analysis-1',
        5,
        { itemId: 'W-1', outcome: 'applied', note: null },
        { seq: 12, at: new Date('2026-10-20T11:00:00.000Z') },
      );

      publish('analysis-1', 9, 'recommendation_outcome', {
        cardSeq: 5,
        outcomes: [{ id: 'W-1', status: 'failed', note: 'stale' }],
      });
      await service.settled();

      expect((await dao.rowsOf('dev-team'))[0]).toMatchObject({
        outcome: 'applied',
        outcomeSeq: 12,
      });
    });
  });

  describe('sweep', () => {
    it('reads an item filed before the rename, whose target says workflow, as a team item', async () => {
      const [filed] = filedRecommendationsOf(
        { slug: 'dev-team', chatRunId: 'analysis-1', chatKind: 'analysis' },
        {
          seq: 4,
          createdAt: new Date(0),
          payload: {
            ...card(['W-1']),
            sourceKind: 'workflow',
            items: card(['W-1']).items.map((item) => ({
              ...item,
              target: 'workflow',
            })),
          },
        },
        null,
      )!;
      expect(filed?.target).toBe('team');
      await dao.file([{ ...filed!, target: 'workflow' }]);

      expect((await dao.rowsOf('dev-team')).map((row) => row.target)).toEqual([
        'team',
      ]);
    });

    it('copies what the live copy missed from every team chat that still exists, once', async () => {
      const row = (
        seq: number,
        kind: string,
        payload: unknown,
        role: string | null = null,
      ): StoredRow => ({
        seq,
        kind,
        role,
        createdAt: new Date(
          `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`,
        ),
        payload: JSON.stringify(payload),
      });
      stored.set('analysis-1', [
        row(5, 'recommendations', card(['W-1', 'W-2'])),
        row(7, 'message', { apply: { cardSeq: 5, ids: ['W-2'] } }, 'user'),
        row(8, 'recommendation_outcome', {
          cardSeq: 5,
          outcomes: [{ id: 'W-2', status: 'skipped', note: 'not now' }],
        }),
      ]);
      stored.set('plain-chat', [row(2, 'recommendations', card(['R-1']))]);

      await expect(service.sweep()).resolves.toBe(2);
      await service.sweep();

      const rows = await dao.rowsOf('dev-team');
      expect(rows.map((entry) => [entry.itemId, entry.outcome])).toEqual([
        ['W-1', null],
        ['W-2', 'skipped'],
      ]);
      expect(rows[1]).toMatchObject({
        selectedAt: new Date('2026-10-20T10:00:07.000Z'),
        outcomeNote: 'not now',
        libraryVersion: null,
      });
    });
  });
});
