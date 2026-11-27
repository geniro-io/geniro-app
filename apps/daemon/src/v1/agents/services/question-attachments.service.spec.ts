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
    service = new QuestionAttachmentsService(artifacts);
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

  it('attaches no page to a question that passed none, even one it names or its turn showed', async () => {
    await write(1, 'message', { text: 'hi' }, 'user');
    await write(2, 'show_artifact', page('plan-page', 'Launch plan'));
    await write(3, 'show_gallery', {
      title: 'Office photos',
      images: [{ path: '/tmp/a.png' }],
    });

    expect(
      await service.cardFields(RUN, asks('Use the Launch plan or not?')),
    ).toEqual({ attachments: [], moreAttachments: 0 });
    expect(
      await service.cardFields(RUN, asks('Use the Launch plan?'), []),
    ).toEqual({ attachments: [], moreAttachments: 0 });
  });

  it('attaches exactly the pages passed, each once at its newest version', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));
    await write(2, 'show_artifact', page('chart-page', 'Quarterly chart'));
    await write(3, 'show_artifact', {
      ...page('plan-page', 'Launch plan'),
      version: 2,
    });

    expect(
      await service.cardFields(RUN, asks('Which one?'), [
        'plan-page',
        'plan-page',
      ]),
    ).toEqual({
      attachments: [
        {
          kind: 'artifact',
          artifactId: 'plan-page',
          title: 'Launch plan',
          version: 2,
        },
      ],
      moreAttachments: 0,
    });
  });

  it('attaches nothing and does not throw when the run’s pages cannot be read', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));
    vi.spyOn(artifacts, 'read').mockRejectedValueOnce(
      new Error('the page listing is gone'),
    );

    await expect(
      service.cardFields(RUN, asks('Use it?'), ['plan-page']),
    ).resolves.toEqual({ attachments: [], moreAttachments: 0 });
    expect(
      await service.cardFields(RUN, asks('Use it?'), ['plan-page']),
    ).toMatchObject({ attachments: [{ artifactId: 'plan-page' }] });
  });

  it('gives no fields to a card with no questions, whatever pages it passed', async () => {
    await write(1, 'show_artifact', page('plan-page', 'Launch plan'));

    expect(await service.cardFields(RUN, undefined, ['plan-page'])).toEqual({});
    expect(await service.cardFields(RUN, [], ['plan-page'])).toEqual({});
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

  it('leaves the page ids unchecked rather than refusing the question when the pages cannot be read', async () => {
    vi.spyOn(artifacts, 'read').mockRejectedValueOnce(
      new Error('the page listing is gone'),
    );

    await expect(service.unknownPages(RUN, ['ghost-page'])).resolves.toEqual({
      unknown: [],
      published: [],
    });
  });
});
