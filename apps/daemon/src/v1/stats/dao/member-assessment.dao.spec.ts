import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { columnsByTable } from '../../migrations/utils/rename-columns';
import { MemberAssessmentRecord } from '../entity/member-assessment.entity';
import type { MemberAssessmentRow } from '../stats.types';
import { MemberAssessmentDao } from './member-assessment.dao';

interface OlderProfile {
  member_assessments: {
    member_id: string;
    user_verdict: string | null;
    user_note: string | null;
    user_verdict_at: number | null;
  };
}

const OLDER_COLUMNS = ['user_verdict', 'user_note', 'user_verdict_at'];

function assessmentOf(memberId: string): MemberAssessmentRow {
  return {
    slug: 'dev-team',
    chatRunId: 'analysis-1',
    chatKind: 'analysis',
    cardSeq: 5,
    filedAt: new Date('2026-10-20T10:00:00.000Z'),
    libraryVersion: null,
    runs: 2,
    runIds: ['r1'],
    memberId,
    usefulness: 3,
    quality: 4,
    verdict: 'keep',
    summary: 'Fine',
    evidence: [],
    items: [],
    judge: { agent: 'claude', model: null },
  };
}

describe('MemberAssessmentDao on an older profile (in-memory sqlite)', () => {
  let orm: MikroORM;

  const db = (): Kysely<OlderProfile> =>
    orm.em.fork().getKysely<OlderProfile>({ convertValues: false });

  async function olderColumnsPresent(): Promise<string[]> {
    const columns = (
      await columnsByTable(db() as unknown as Kysely<unknown>)
    ).get('member_assessments');
    return OLDER_COLUMNS.filter((column) => columns?.has(column) ?? false);
  }

  beforeEach(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [MemberAssessmentRecord],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.update({ safe: true });
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('keeps the verdict columns an older profile holds, and their values, through the schema sync, and files beside them', async () => {
    expect(await olderColumnsPresent()).toEqual([]);
    for (const [column, type] of [
      ['user_verdict', 'text'],
      ['user_note', 'text'],
      ['user_verdict_at', 'datetime'],
    ] as const) {
      await db()
        .schema.alterTable('member_assessments')
        .addColumn(column, type)
        .execute();
    }
    const dao = new MemberAssessmentDao(orm.em.fork());
    await dao.file([assessmentOf('dev')]);
    await db()
      .updateTable('member_assessments')
      .set({
        user_verdict: 'disagree',
        user_note: 'it skipped the tests',
        user_verdict_at: 1_761_040_800_000,
      })
      .where('member_id', '=', 'dev')
      .execute();

    await orm.schema.update({ safe: true });
    await dao.file([assessmentOf('qa')]);

    expect(await olderColumnsPresent()).toEqual(OLDER_COLUMNS);
    expect(
      await db()
        .selectFrom('member_assessments')
        .select(['member_id', 'user_verdict', 'user_note', 'user_verdict_at'])
        .orderBy('member_id', 'asc')
        .execute(),
    ).toEqual([
      {
        member_id: 'dev',
        user_verdict: 'disagree',
        user_note: 'it skipped the tests',
        user_verdict_at: 1_761_040_800_000,
      },
      {
        member_id: 'qa',
        user_verdict: null,
        user_note: null,
        user_verdict_at: null,
      },
    ]);
    expect((await dao.rowsOf('dev-team')).map((row) => row.memberId)).toEqual([
      'dev',
      'qa',
    ]);
  });
});
