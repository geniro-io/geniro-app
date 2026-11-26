import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { searchConfigOf, SearchConfigPush } from './search-config-push';
import type { ReadyModel } from './search-model/search-model-downloader';

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'launch-token',
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
};

const MODEL: ReadyModel = {
  id: 'embeddinggemma-2',
  revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
  dim: 768,
  dir: '/Users/someone/Library/Application Support/Geniro/models/embeddinggemma-2-daa72c5',
};

const ALL_SOURCES = { memory: true, knowledge: true, chats: true };

function recordingFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response());
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('searchConfigOf', () => {
  it('is off until a model is ready, even with the switch on', () => {
    expect(
      searchConfigOf({
        switchOn: true,
        sources: ALL_SOURCES,
        chatWindowDays: null,
        model: null,
        pendingModel: null,
        onBattery: false,
      }).enabled,
    ).toBe(false);
  });

  it('is off while the switch is off, even with a model ready', () => {
    expect(
      searchConfigOf({
        switchOn: false,
        sources: ALL_SOURCES,
        chatWindowDays: null,
        model: MODEL,
        pendingModel: null,
        onBattery: false,
      }).enabled,
    ).toBe(false);
  });

  it('is on when the switch is on and a model is ready, and sends each model as id, revision, dir and dim', () => {
    const pending: ReadyModel = {
      ...MODEL,
      revision: 'newrev0123456789',
      dir: '/models/new',
    };

    expect(
      searchConfigOf({
        switchOn: true,
        sources: ALL_SOURCES,
        chatWindowDays: null,
        model: MODEL,
        pendingModel: pending,
        onBattery: true,
      }),
    ).toEqual({
      enabled: true,
      sources: ALL_SOURCES,
      chatWindowDays: null,
      model: {
        id: MODEL.id,
        revision: MODEL.revision,
        dir: MODEL.dir,
        dim: 768,
      },
      pendingModel: {
        id: MODEL.id,
        revision: 'newrev0123456789',
        dir: '/models/new',
        dim: 768,
      },
      onBattery: true,
    });
  });

  it('sends the chosen sources and window to the daemon unchanged', () => {
    const config = searchConfigOf({
      switchOn: true,
      sources: { memory: false, knowledge: true, chats: true },
      chatWindowDays: 30,
      model: MODEL,
      pendingModel: null,
      onBattery: false,
    });

    expect(config.sources).toEqual({
      memory: false,
      knowledge: true,
      chats: true,
    });
    expect(config.chatWindowDays).toBe(30);
  });

  it('sends no field a model folder carries beyond the four the daemon reads', () => {
    const config = searchConfigOf({
      switchOn: true,
      sources: ALL_SOURCES,
      chatWindowDays: null,
      model: { ...MODEL, extra: 'not sent' } as ReadyModel,
      pendingModel: null,
      onBattery: false,
    });

    expect(Object.keys(config.model ?? {}).sort()).toEqual([
      'dim',
      'dir',
      'id',
      'revision',
    ]);
  });
});

describe('SearchConfigPush', () => {
  it('PUTs the search settings to the daemon with the launch token', async () => {
    const http = recordingFetch(() => new Response('{}', { status: 200 }));

    const accepted = await new SearchConfigPush(
      () => undefined,
      http.fetchImpl,
    ).push(
      HANDLE,
      searchConfigOf({
        switchOn: true,
        sources: ALL_SOURCES,
        chatWindowDays: 30,
        model: MODEL,
        pendingModel: null,
        onBattery: true,
      }),
    );

    expect(accepted).toBe(true);
    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/embeddings/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      enabled: true,
      onBattery: true,
      pendingModel: null,
      model: { id: MODEL.id, dim: 768 },
      sources: ALL_SOURCES,
      chatWindowDays: 30,
    });
  });

  it('pushes again when only the sources or the window change', async () => {
    const http = recordingFetch(() => new Response('{}', { status: 200 }));
    const push = new SearchConfigPush(() => undefined, http.fetchImpl);
    const config = (
      sources: typeof ALL_SOURCES,
      chatWindowDays: number | null,
    ) =>
      searchConfigOf({
        switchOn: true,
        sources,
        chatWindowDays,
        model: MODEL,
        pendingModel: null,
        onBattery: false,
      });

    await push.pushIfChanged(HANDLE, config(ALL_SOURCES, null));
    await push.pushIfChanged(
      HANDLE,
      config({ ...ALL_SOURCES, knowledge: false }, null),
    );
    await push.pushIfChanged(
      HANDLE,
      config({ ...ALL_SOURCES, knowledge: false }, 30),
    );
    await push.pushIfChanged(
      HANDLE,
      config({ ...ALL_SOURCES, knowledge: false }, 30),
    );

    expect(http.calls).toHaveLength(3);
  });

  it('reports a refused push as not accepted', async () => {
    const reports: string[] = [];
    const http = recordingFetch(() => new Response('{}', { status: 500 }));

    const accepted = await new SearchConfigPush(
      (message) => reports.push(message),
      http.fetchImpl,
    ).push(
      HANDLE,
      searchConfigOf({
        switchOn: false,
        sources: ALL_SOURCES,
        chatWindowDays: null,
        model: null,
        pendingModel: null,
        onBattery: false,
      }),
    );

    expect(accepted).toBe(false);
    expect(reports).toEqual([
      'the daemon refused the search settings (500); the daemon keeps search by meaning off until they are saved again',
    ]);
  });

  it('reads the pending model as complete only when the daemon says so', async () => {
    const complete = new SearchConfigPush(
      () => undefined,
      recordingFetch(
        () =>
          new Response(JSON.stringify({ pendingModel: { complete: true } })),
      ).fetchImpl,
    );
    const indexing = new SearchConfigPush(
      () => undefined,
      recordingFetch(
        () =>
          new Response(JSON.stringify({ pendingModel: { complete: false } })),
      ).fetchImpl,
    );
    const none = new SearchConfigPush(
      () => undefined,
      recordingFetch(() => new Response(JSON.stringify({ pendingModel: null })))
        .fetchImpl,
    );

    expect(await complete.pendingIndexComplete(HANDLE)).toBe(true);
    expect(await indexing.pendingIndexComplete(HANDLE)).toBe(false);
    expect(await none.pendingIndexComplete(HANDLE)).toBe(false);
  });

  it('a daemon that cannot answer the status is "not complete yet"', async () => {
    const push = new SearchConfigPush(
      () => undefined,
      recordingFetch(() => new Response('{}', { status: 503 })).fetchImpl,
    );

    expect(await push.pendingIndexComplete(HANDLE)).toBe(false);
    expect(await push.pendingIndexComplete(null)).toBe(false);
  });
});
