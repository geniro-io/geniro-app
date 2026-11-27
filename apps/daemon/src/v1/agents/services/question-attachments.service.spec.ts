import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
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

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { ArtifactStoreService } from './artifact-store.service';
import { ChatArtifactsService } from './chat-artifacts.service';
import { QuestionAttachmentsService } from './question-attachments.service';

const RUN = 'run-q';
const KEY = 'k'.repeat(64);

function page(artifactId: string, title: string): Record<string, unknown> {
  return { artifactId, version: 1, title, key: KEY };
}

function asks(
  text: string,
): { question: string; options: { label: string }[] }[] {
  return [{ question: text, options: [{ label: 'Yes' }] }];
}

describe('QuestionAttachmentsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let artifacts: ChatArtifactsService;
  let service: QuestionAttachmentsService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
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
    const em = orm.em.fork() as EntityManager;
    const runs = new RunDao(em);
    items = new ItemDao(em);
    await runs.create({ id: RUN, status: 'running' });
    artifacts = new ChatArtifactsService(
      em,
      runs,
      items,
      new ArtifactStoreService({ root: join(tmpdir(), 'unused') }),
    );
    service = new QuestionAttachmentsService(em, items, artifacts);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function write(
    seq: number,
    kind: ItemKind,
    payload: Record<string, unknown> = {},
    role: string | null = null,
  ): Promise<void> {
    await items.create({
      runId: RUN,
      seq,
      kind,
      role,
      payload: JSON.stringify(payload),
    });
  }

  it('attaches a page from an earlier turn only when the question names its exact title', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));
    await write(2, 'message', { text: 'hi' }, 'user');

    expect(
      await service.cardFields(RUN, null, asks('Use the Launch plan or not?')),
    ).toEqual({
      attachments: [
        {
          kind: 'artifact',
          artifactId: 'plan-page',
          title: 'Launch plan',
          version: 1,
        },
      ],
      moreAttachments: 0,
    });
    expect(
      await service.cardFields(RUN, null, asks('Use the launch option?')),
    ).toEqual({ attachments: [], moreAttachments: 0 });
  });

  it('attaches the asking turn’s pages and picture sets, newest row first', async () => {
    await write(1, 'message', { text: 'hi' }, 'user');
    await write(2, 'show_artifact', page('chart-page', 'Quarterly chart'));
    await write(3, 'show_gallery', {
      title: 'Office photos',
      images: [{ path: '/tmp/a.png' }],
    });

    expect(
      await service.cardFields(RUN, null, asks('Which one fits?')),
    ).toEqual({
      attachments: [
        {
          kind: 'gallery',
          seq: 3,
          title: 'Office photos',
          count: 1,
          gallery: {
            title: 'Office photos',
            images: [{ path: '/tmp/a.png' }],
          },
        },
        {
          kind: 'artifact',
          artifactId: 'chart-page',
          title: 'Quarterly chart',
          version: 1,
        },
      ],
      moreAttachments: 0,
    });
  });

  it('starts a call’s turn at its call_started row when the card names a callId', async () => {
    await write(1, 'message', { text: 'hi' }, 'user');
    await write(2, 'show_gallery', {
      title: 'Before the call',
      images: [{ path: '/tmp/b.png' }],
    });
    await write(3, 'call_started', { callId: 'call-7' });
    await write(4, 'show_gallery', {
      title: 'Inside the call',
      images: [{ path: '/tmp/c.png' }],
    });

    const inCall = await service.cardFields(
      RUN,
      null,
      asks('Pick one'),
      [],
      'call-7',
    );
    expect(inCall).toMatchObject({
      attachments: [{ kind: 'gallery', seq: 4, title: 'Inside the call' }],
    });

    const wholeTurn = await service.cardFields(RUN, null, asks('Pick one'));
    expect(wholeTurn).toMatchObject({
      attachments: [
        { kind: 'gallery', seq: 4 },
        { kind: 'gallery', seq: 2 },
      ],
    });
  });

  it('attaches nothing and does not throw when the run’s pages cannot be read', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));
    await write(2, 'message', { text: 'hi' }, 'user');
    vi.spyOn(artifacts, 'read').mockRejectedValueOnce(
      new Error('the page listing is gone'),
    );

    await expect(
      service.cardFields(RUN, null, asks('Use the Launch plan?')),
    ).resolves.toEqual({ attachments: [], moreAttachments: 0 });
    expect(
      await service.cardFields(RUN, null, asks('Use the Launch plan?')),
    ).toMatchObject({ attachments: [{ artifactId: 'plan-page' }] });
  });

  it('gives no fields to a card with no questions, whatever its title names', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));
    await write(2, 'message', { text: 'hi' }, 'user');

    expect(await service.cardFields(RUN, 'Launch plan', undefined)).toEqual({});
    expect(await service.cardFields(RUN, 'Launch plan', [])).toEqual({});
  });

  it('tells the unknown page ids apart from the ones the run published', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));
    await write(2, 'show_artifact', page('chart-page', 'Quarterly chart'));

    expect(
      await service.unknownPages(RUN, ['plan-page', 'ghost-page']),
    ).toEqual({
      unknown: ['ghost-page'],
      published: ['chart-page', 'plan-page'],
    });
  });
});
