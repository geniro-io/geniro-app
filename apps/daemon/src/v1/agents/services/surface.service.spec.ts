import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { ConflictException } from '@packages/common';
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
import { clearSecrets, redactSecrets } from '../../diagnostics/utils/redact';
import { UiSurface } from '../../runs/entity/ui-surface.entity';
import {
  MAX_UI_DRAFT_BYTES,
  MAX_UI_LIVE_SURFACES,
  type SurfacePressBody,
  type SurfacePublisher,
  type SurfaceRowPayload,
  UI_OBSCURED_MASK,
} from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { UiSurfaceDao } from '../dao/ui-surface.dao';
import {
  type downloadRemoteFile,
  RemoteImageError,
} from '../utils/remote-image';
import { AttachmentStoreService } from './attachment-store.service';
import { RunDownloadBudget } from './run-download-budget.service';
import {
  type SurfacePressMessage,
  type SurfaceRowSink,
  SurfaceService,
} from './surface.service';
import { SurfaceMediaService } from './surface-media.service';

const ALICE: SurfacePublisher = {
  memberId: 'a',
  conversationId: null,
  callId: null,
  agentLabel: 'Alice',
};
const BOB: SurfacePublisher = { ...ALICE, memberId: 'b', agentLabel: 'Bob' };

const TEXT = (id: string, text: string) => ({ id, component: 'Text', text });

function createSurface(surfaceId: string, components: unknown[]): unknown {
  return { version: '1.0', createSurface: { surfaceId, components } };
}

function updateComponents(surfaceId: string, components: unknown[]): unknown {
  return { version: '1.0', updateComponents: { surfaceId, components } };
}

function updateData(surfaceId: string, path: string, value: unknown): unknown {
  return { version: '1.0', updateDataModel: { surfaceId, path, value } };
}

function deleteSurface(surfaceId: string): unknown {
  return { version: '1.0', deleteSurface: { surfaceId } };
}

function countingSink(first = 10) {
  let next = first;
  return vi.fn(async (_payload: SurfaceRowPayload) => next++);
}

function pressBody(
  overrides: Pick<SurfacePressBody, 'sourceComponentId' | 'clientMessageId'> &
    Partial<SurfacePressBody>,
): SurfacePressBody {
  return { changes: {}, userMessage: null, context: {}, ...overrides };
}

const FORM_COMPONENTS = [
  { id: 'root', component: 'Column', children: ['name', 'pw', 'go'] },
  {
    id: 'name',
    component: 'TextField',
    label: 'Name',
    value: { '@path': '/form/name' },
  },
  {
    id: 'pw',
    component: 'TextField',
    label: 'Password',
    value: { '@path': '/form/pw' },
    variant: 'obscured',
  },
  {
    id: 'go',
    component: 'Button',
    child: 'go_label',
    action: { event: { name: 'submit', context: {} } },
  },
  TEXT('go_label', 'Send'),
];

const ONE_SHOT_COMPONENTS = [
  { id: 'root', component: 'Column', children: ['once'] },
  {
    id: 'once',
    component: 'Button',
    child: 'once_label',
    action: { event: { name: 'approve', context: {} } },
    '@metadata': { extensions: { geniroOneShot: true } },
  },
  TEXT('once_label', 'Approve'),
];

let orm: MikroORM;
let dao: UiSurfaceDao;

beforeAll(async () => {
  orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [UiSurface],
      ignoreUndefinedInQuery: true,
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
    }),
  );
  await orm.schema.create();
  dao = new UiSurfaceDao(orm.em);
});

afterAll(async () => {
  await orm.close(true);
});

let root: string;
let runId: string;
let service: SurfaceService;

beforeEach(async () => {
  await orm.schema.clear();
  root = mkdtempSync(join(tmpdir(), 'surface-service-'));
  runId = randomUUID();
  const runs = {
    getById: () => Promise.resolve({ cwd: root }),
  } as unknown as RunDao;
  const media = new SurfaceMediaService(
    new AttachmentStoreService({ root }),
    new RunDownloadBudget(),
    runs,
    {
      download: () =>
        Promise.reject(new RemoteImageError('no download in this spec')),
    },
  );
  service = new SurfaceService(orm.em, dao, media);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function draw(
  messages: unknown[],
  sink: SurfaceRowSink,
  publisher: SurfacePublisher = ALICE,
  title: string | null = null,
) {
  return service.draw(runId, publisher, { title, messages }, sink);
}

async function drawForm(): Promise<void> {
  const outcome = await draw(
    [createSurface('form', FORM_COMPONENTS)],
    countingSink(),
    ALICE,
    'Order form',
  );
  expect(outcome).toMatchObject({ status: 'shown', op: 'create' });
}

describe('SurfaceService.draw', () => {
  it('shows a new card, stores it, and announces it in the run', async () => {
    const sink = countingSink();
    const outcome = await draw(
      [createSurface('plan', [TEXT('root', 'Hello')])],
      sink,
      ALICE,
      'Plan',
    );

    expect(outcome).toEqual({
      status: 'shown',
      surfaceId: 'plan',
      version: 1,
      op: 'create',
      components: 1,
      media: 0,
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      surfaceId: 'plan',
      version: 1,
      op: 'create',
      title: 'Plan',
    });

    const wire = await service.read(runId, 'plan');
    expect(wire.components).toEqual([TEXT('root', 'Hello')]);
    expect(wire.dataModel).toEqual({});
    expect(wire.title).toBe('Plan');

    expect(await service.index(runId)).toEqual([
      {
        surfaceId: 'plan',
        version: 1,
        firstSeq: 10,
        removed: false,
        publisher: { memberId: 'a', agentLabel: 'Alice' },
      },
    ]);
  });

  it('refuses an invalid message, announces nothing and stores nothing', async () => {
    const sink = countingSink();
    const outcome = await draw(
      [createSurface('bad', [{ id: 'root', component: 'Carousel' }])],
      sink,
    );

    expect(outcome).toMatchObject({
      status: 'invalid',
      error: expect.stringMatching(/^\/messages\/0\//),
    });
    expect(sink).not.toHaveBeenCalled();
    await expect(service.read(runId, 'bad')).rejects.toMatchObject({
      errorCode: 'UI_SURFACE_NOT_FOUND',
    });
  });

  it('replaces the components named by id on update and bumps the version', async () => {
    const sink = countingSink();
    await draw(
      [
        createSurface('plan', [
          { id: 'root', component: 'Column', children: ['note'] },
          TEXT('note', 'first'),
        ]),
      ],
      sink,
    );

    const outcome = await draw(
      [updateComponents('plan', [TEXT('note', 'second')])],
      sink,
    );

    expect(outcome).toEqual({
      status: 'shown',
      surfaceId: 'plan',
      version: 2,
      op: 'update',
      components: 2,
      media: 0,
    });
    expect(sink).toHaveBeenLastCalledWith({
      surfaceId: 'plan',
      version: 2,
      op: 'update',
      title: null,
    });
    const wire = await service.read(runId, 'plan');
    expect(wire.version).toBe(2);
    expect(wire.components).toEqual([
      { id: 'root', component: 'Column', children: ['note'] },
      TEXT('note', 'second'),
    ]);
  });

  it('refuses a second createSurface for an id that already exists', async () => {
    const sink = countingSink();
    await draw([createSurface('plan', [TEXT('root', 'one')])], sink);

    const outcome = await draw(
      [createSurface('plan', [TEXT('root', 'two')])],
      sink,
    );

    expect(outcome).toMatchObject({
      status: 'invalid',
      error: expect.stringContaining('already exists'),
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect((await service.read(runId, 'plan')).components).toEqual([
      TEXT('root', 'one'),
    ]);
  });

  it('refuses a card another agent drew', async () => {
    await draw([createSurface('plan', [TEXT('root', 'mine')])], countingSink());

    const outcome = await draw(
      [updateComponents('plan', [TEXT('root', 'theirs')])],
      countingSink(),
      BOB,
    );

    expect(outcome).toMatchObject({
      status: 'invalid',
      error: expect.stringContaining('belongs to another agent'),
    });
    expect((await service.read(runId, 'plan')).components).toEqual([
      TEXT('root', 'mine'),
    ]);
  });

  it('refuses a new card past the live cap, naming the cap', async () => {
    const sink = countingSink();
    for (let index = 0; index < MAX_UI_LIVE_SURFACES; index += 1) {
      const outcome = await draw(
        [createSurface(`card-${index}`, [TEXT('root', 'x')])],
        sink,
      );
      expect(outcome).toMatchObject({ status: 'shown' });
    }

    const over = await draw(
      [createSurface('one-more', [TEXT('root', 'x')])],
      sink,
    );

    expect(over).toMatchObject({
      status: 'invalid',
      error: expect.stringContaining(`${MAX_UI_LIVE_SURFACES} cards`),
    });
    expect(sink).toHaveBeenCalledTimes(MAX_UI_LIVE_SURFACES);
  });

  it('reports unavailable and takes the card back when the run cannot record it', async () => {
    const sink = vi.fn(async (): Promise<number> => {
      throw new Error('disk full');
    });

    const outcome = await draw(
      [createSurface('plan', [TEXT('root', 'x')])],
      sink,
    );

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'the card could not be saved',
    });
    await expect(service.read(runId, 'plan')).rejects.toMatchObject({
      errorCode: 'UI_SURFACE_NOT_FOUND',
    });
    expect(await service.index(runId)).toEqual([]);
  });
});

describe('SurfaceService drafts', () => {
  it('keeps the drafts an agent write did not overwrite, and drops the ones it did', async () => {
    await drawForm();
    await service.saveDrafts(runId, 'form', 1, {
      '/form/name': 'Ann',
      '/form/age': 3,
    });

    await draw([updateData('form', '/form/name', 'Bob')], countingSink());

    const wire = await service.read(runId, 'form');
    expect(wire.drafts).toEqual({ '/form/age': 3 });
    expect(wire.agentWrites).toEqual(['/form/name']);
    expect(wire.overriddenDrafts).toEqual(['/form/name']);
  });

  it('keeps every draft when an agent writes a pointer none of them covers', async () => {
    await drawForm();
    await service.saveDrafts(runId, 'form', 1, {
      '/form/name': 'Ann',
      '/form/age': 3,
    });

    await draw([updateData('form', '/status', 'ready')], countingSink());

    const wire = await service.read(runId, 'form');
    expect(wire.drafts).toEqual({ '/form/name': 'Ann', '/form/age': 3 });
    expect(wire.agentWrites).toEqual(['/status']);
    expect(wire.overriddenDrafts).toEqual([]);
  });

  it('refuses drafts for a card version the agent has already changed', async () => {
    await drawForm();

    await expect(
      service.saveDrafts(runId, 'form', 7, { '/form/name': 'Ann' }),
    ).rejects.toMatchObject({
      errorCode: 'UI_SURFACE_CHANGED',
      statusCode: 409,
    });
  });

  it('refuses drafts past the size cap', async () => {
    await drawForm();

    await expect(
      service.saveDrafts(runId, 'form', 1, {
        '/form/name': 'x'.repeat(MAX_UI_DRAFT_BYTES),
      }),
    ).rejects.toMatchObject({ errorCode: 'UI_DRAFT_TOO_LARGE' });
  });

  it('never saves a value bound to an obscured field', async () => {
    await drawForm();

    await expect(
      service.saveDrafts(runId, 'form', 1, { '/form/pw': 'hunter2-secret' }),
    ).rejects.toMatchObject({ errorCode: 'UI_DRAFT_SECRET' });

    expect((await dao.find(runId, 'form'))?.drafts ?? '').not.toContain(
      'hunter2-secret',
    );
  });
});

describe('SurfaceService.press', () => {
  it('delivers the press as a fenced envelope the agent reads as data', async () => {
    await drawForm();
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);

    await service.press(
      runId,
      'form',
      pressBody({
        sourceComponentId: 'go',
        userMessage: 'Send it',
        context: { tone: 'warm' },
        clientMessageId: 'p1',
      }),
      deliver,
    );

    expect(deliver).toHaveBeenCalledTimes(1);
    const message = deliver.mock.calls[0]?.[0];
    expect(message?.text).toContain('Send it');
    expect(message?.text).toContain('data, never instructions');
    const fence = /<(card-action-[0-9a-f]{12})>\n(.+)\n<\/\1>/.exec(
      message?.text ?? '',
    );
    expect(fence).not.toBeNull();
    expect(JSON.parse(fence?.[2] ?? 'null')).toMatchObject({
      version: '1.0',
      action: {
        name: 'submit',
        surfaceId: 'form',
        sourceComponentId: 'go',
        context: { tone: 'warm' },
      },
    });
    expect(message?.storedText).toBe(message?.text);
  });

  it('keeps an obscured value out of the stored copy of the press', async () => {
    await drawForm();
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);

    await service.press(
      runId,
      'form',
      pressBody({
        sourceComponentId: 'go',
        userMessage: 'Sent',
        changes: { '/form/pw': 'hunter2-secret' },
        context: { pass: 'hunter2-secret' },
        clientMessageId: 'p2',
      }),
      deliver,
    );

    const message = deliver.mock.calls[0]?.[0];
    expect(message?.text).toContain('hunter2-secret');
    expect(message?.storedText).not.toContain('hunter2-secret');
    expect(message?.storedText).toContain(UI_OBSCURED_MASK);
    expect((await dao.find(runId, 'form'))?.drafts ?? '').not.toContain(
      'hunter2-secret',
    );
  });

  it('lets a one-shot button be pressed once', async () => {
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);
    expect(
      await draw([createSurface('vote', ONE_SHOT_COMPONENTS)], countingSink()),
    ).toMatchObject({ status: 'shown', op: 'create' });

    const first = await service.press(
      runId,
      'vote',
      pressBody({ sourceComponentId: 'once', clientMessageId: 'o1' }),
      deliver,
    );
    expect(first.oneShotPressed).toEqual(['once']);

    await expect(
      service.press(
        runId,
        'vote',
        pressBody({ sourceComponentId: 'once', clientMessageId: 'o2' }),
        deliver,
      ),
    ).rejects.toMatchObject({
      errorCode: 'UI_ALREADY_PRESSED',
      statusCode: 409,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('lets a plain button be pressed again and again', async () => {
    await drawForm();
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);

    await service.press(
      runId,
      'form',
      pressBody({ sourceComponentId: 'go', clientMessageId: 'g1' }),
      deliver,
    );
    await service.press(
      runId,
      'form',
      pressBody({ sourceComponentId: 'go', clientMessageId: 'g2' }),
      deliver,
    );

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('records nothing when delivery is refused, so the press can be made again', async () => {
    await drawForm();
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);
    deliver.mockRejectedValueOnce(
      new ConflictException('RUN_BUSY', 'the agent is busy'),
    );

    await expect(
      service.press(
        runId,
        'form',
        pressBody({
          sourceComponentId: 'go',
          changes: { '/form/name': 'Ann' },
          clientMessageId: 'r1',
        }),
        deliver,
      ),
    ).rejects.toMatchObject({ errorCode: 'RUN_BUSY' });
    expect((await service.read(runId, 'form')).drafts).toEqual({});

    await service.press(
      runId,
      'form',
      pressBody({ sourceComponentId: 'go', clientMessageId: 'r2' }),
      deliver,
    );
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('refuses a component that sends nothing to the agent', async () => {
    await drawForm();

    await expect(
      service.press(
        runId,
        'form',
        pressBody({ sourceComponentId: 'go_label', clientMessageId: 'n1' }),
        vi.fn(async (_message: SurfacePressMessage) => undefined),
      ),
    ).rejects.toMatchObject({ errorCode: 'UI_NOT_A_BUTTON', statusCode: 400 });
  });

  it('refuses a press on a card the agent removed', async () => {
    await drawForm();
    await draw([deleteSurface('form')], countingSink());

    await expect(
      service.press(
        runId,
        'form',
        pressBody({ sourceComponentId: 'go', clientMessageId: 'x1' }),
        vi.fn(async (_message: SurfacePressMessage) => undefined),
      ),
    ).rejects.toMatchObject({ errorCode: 'UI_SURFACE_REMOVED' });
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const LOGIN_COMPONENTS = [
  { id: 'root', component: 'Column', children: ['pw', 'go'] },
  {
    id: 'pw',
    component: 'TextField',
    label: 'Password',
    value: { '@path': '/password' },
    variant: 'obscured',
  },
  {
    id: 'go',
    component: 'Button',
    child: 'go_label',
    action: {
      event: { name: 'login', context: { pass: { '@path': '/password' } } },
    },
  },
  TEXT('go_label', 'Log in'),
];

const WHO_COMPONENTS = [
  { id: 'root', component: 'Column', children: ['who', 'go'] },
  {
    id: 'who',
    component: 'TextField',
    label: 'Who',
    value: { '@path': '/who' },
  },
  {
    id: 'go',
    component: 'Button',
    child: 'go_label',
    action: {
      event: { name: 'greet', context: { who: { '@path': '/who' } } },
    },
  },
  TEXT('go_label', 'Greet'),
];

const PHOTO_COMPONENTS = (url: string) => [
  { id: 'root', component: 'Column', children: ['photo', 'note'] },
  { id: 'photo', component: 'Image', url },
  TEXT('note', 'one'),
];

async function mediaFilesOf(surfaceId: string): Promise<string[]> {
  return Object.keys((await service.read(runId, surfaceId)).media);
}

describe('SurfaceService.press — values from a button context', () => {
  it('masks a value a button sends as context from an obscured field, and registers it with the redactor', async () => {
    await draw(
      [createSurface('login', LOGIN_COMPONENTS)],
      countingSink(),
      ALICE,
      'Login',
    );
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);
    clearSecrets();

    await service.press(
      runId,
      'login',
      pressBody({
        sourceComponentId: 'go',
        userMessage: 'Log in',
        context: { pass: 'hunter2-secret' },
        clientMessageId: 'a1',
      }),
      deliver,
    );

    const message = deliver.mock.calls[0]?.[0];
    expect(message?.text).toContain('hunter2-secret');
    expect(message?.storedText).not.toContain('hunter2-secret');
    expect(message?.storedText).toContain(UI_OBSCURED_MASK);
    expect(redactSecrets('hunter2-secret')).not.toContain('hunter2-secret');
  });

  it('keeps a value a button sends as context from a field that is not obscured in the stored copy', async () => {
    await draw([createSurface('who', WHO_COMPONENTS)], countingSink());
    const deliver = vi.fn(async (_message: SurfacePressMessage) => undefined);

    await service.press(
      runId,
      'who',
      pressBody({
        sourceComponentId: 'go',
        userMessage: 'Greet',
        context: { who: 'Ann' },
        clientMessageId: 'a2',
      }),
      deliver,
    );

    const message = deliver.mock.calls[0]?.[0];
    expect(message?.text).toContain('Ann');
    expect(message?.storedText).toContain('Ann');
    expect(message?.storedText).not.toContain(UI_OBSCURED_MASK);
  });
});

describe('SurfaceService.draw — pictures a redraw no longer shows', () => {
  it('removes the stored picture a redraw replaces, and keeps the one a redraw leaves in place', async () => {
    const first = join(root, 'first.png');
    const second = join(root, 'second.png');
    writeFileSync(first, PNG);
    writeFileSync(second, PNG);
    const sink = countingSink();
    await draw([createSurface('photos', PHOTO_COMPONENTS(first))], sink);
    const [firstFile = ''] = await mediaFilesOf('photos');
    expect(existsSync(join(root, runId, firstFile))).toBe(true);

    await draw(
      [
        updateComponents('photos', [
          { id: 'photo', component: 'Image', url: second },
        ]),
      ],
      sink,
    );
    const [secondFile = ''] = await mediaFilesOf('photos');
    expect(secondFile).not.toBe(firstFile);
    expect(existsSync(join(root, runId, firstFile))).toBe(false);
    expect(existsSync(join(root, runId, secondFile))).toBe(true);

    await draw([updateComponents('photos', [TEXT('note', 'two')])], sink);
    expect(await mediaFilesOf('photos')).toEqual([secondFile]);
    expect(existsSync(join(root, runId, secondFile))).toBe(true);
  });
});

describe('SurfaceService.draw — a removed card', () => {
  it('refuses an update to a card the agent removed, and leaves that card as it was', async () => {
    const sink = countingSink();
    await draw([createSurface('plan', [TEXT('root', 'one')])], sink);
    await draw([deleteSurface('plan')], sink);
    const before = await service.read(runId, 'plan');
    expect(before).toMatchObject({ removed: true, version: 2 });

    const outcome = await draw(
      [updateComponents('plan', [TEXT('root', 'two')])],
      sink,
    );

    expect(outcome).toEqual({
      status: 'invalid',
      error:
        '/messages/0/updateComponents/surfaceId: surface "plan" was removed; draw a new one under a new surfaceId',
    });
    expect(sink).toHaveBeenCalledTimes(2);
    expect(await service.read(runId, 'plan')).toEqual(before);
  });
});

describe('SurfaceService.draw — a download does not hold the run', () => {
  it('lets a draft save on the run go ahead while a picture of a card is still downloading', async () => {
    let finish: (file: { mediaType: string; bytes: Buffer }) => void = () =>
      undefined;
    const pending = new Promise<{ mediaType: string; bytes: Buffer }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const download = vi.fn(
      () => pending,
    ) as unknown as typeof downloadRemoteFile;
    const gated = new SurfaceService(
      orm.em,
      dao,
      new SurfaceMediaService(
        new AttachmentStoreService({ root }),
        new RunDownloadBudget(),
        { getById: () => Promise.resolve({ cwd: root }) } as unknown as RunDao,
        { download },
      ),
    );
    await gated.draw(
      runId,
      ALICE,
      {
        title: null,
        messages: [
          createSurface('f', [
            { id: 'root', component: 'Column', children: ['note'] },
            TEXT('note', 'one'),
          ]),
        ],
      },
      countingSink(),
    );

    const drawing = gated.draw(
      runId,
      ALICE,
      {
        title: null,
        messages: [
          updateComponents('f', [
            { id: 'root', component: 'Column', children: ['note', 'photo'] },
            TEXT('note', 'one'),
            {
              id: 'photo',
              component: 'Image',
              url: 'https://cdn.example/photo.png',
            },
          ]),
        ],
      },
      countingSink(),
    );
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));

    await gated.saveDrafts(runId, 'f', 1, { '/name': 'x' });
    finish({ mediaType: 'png', bytes: PNG });

    await expect(drawing).resolves.toMatchObject({
      status: 'shown',
      surfaceId: 'f',
      op: 'update',
      version: 2,
    });
    expect((await gated.read(runId, 'f')).drafts).toEqual({ '/name': 'x' });
  });
});
