import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchModelState } from '../../shared/contracts';
import { DownloadHttpError } from '../download';
import { SearchModelService } from './search-model.service';
import {
  modelFolderName,
  type SearchModelDownload,
  type SearchModelManifest,
} from './search-model-downloader';

const MANIFEST: SearchModelManifest = {
  id: 'test-model',
  repo: 'example/test-model',
  revision: 'newrev0123456789',
  tag: 'model-test-newrev0',
  dim: 4,
  files: [
    {
      name: 'model.bin',
      source: 'onnx/model.bin',
      bytes: 10,
      sha256: 'a'.repeat(64),
    },
    {
      name: 'tokenizer.json',
      source: 'tokenizer.json',
      bytes: 20,
      sha256: 'b'.repeat(64),
    },
  ],
};

/** A downloaded model folder: the files and the `ready.json` that marks it complete. */
function writeReadyModel(modelsDir: string, revision: string): string {
  const dir = join(modelsDir, `test-model-${revision.slice(0, 7)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.bin'), 'x'.repeat(10));
  writeFileSync(
    join(dir, 'ready.json'),
    JSON.stringify({
      id: 'test-model',
      revision,
      dim: 4,
      files: ['model.bin'],
    }),
  );
  return dir;
}

interface Harness {
  service: SearchModelService;
  modelsDir: string;
  switchOn: () => boolean;
  writes: boolean[];
  states: SearchModelState[];
  download: ReturnType<typeof vi.fn>;
  pushCount: () => number;
  complete: { value: boolean };
  finishDownload: () => void;
  failDownload: (err: unknown) => void;
}

function harness(
  root: string,
  options: { systemVersion?: string; switchOn?: boolean } = {},
): Harness {
  const modelsDir = join(root, 'models');
  let switchOn = options.switchOn ?? false;
  const writes: boolean[] = [];
  const states: SearchModelState[] = [];
  const complete = { value: false };
  let pushes = 0;
  let finish: () => void = () => undefined;
  let fail: (err: unknown) => void = () => undefined;
  const download = vi.fn(
    (manifest: SearchModelManifest, input: SearchModelDownload) =>
      new Promise<string>((resolve, reject) => {
        input.onProgress({
          phase: 'downloading',
          receivedBytes: 5,
          totalBytes: 30,
        });
        input.signal.addEventListener('abort', () =>
          reject(input.signal.reason),
        );
        finish = () => {
          const dir = join(modelsDir, modelFolderName(manifest));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'model.bin'), 'x'.repeat(10));
          writeFileSync(
            join(dir, 'ready.json'),
            JSON.stringify({
              id: manifest.id,
              revision: manifest.revision,
              dim: manifest.dim,
              files: manifest.files.map((f) => f.name),
            }),
          );
          resolve(dir);
        };
        fail = reject;
      }),
  );
  const service = new SearchModelService({
    manifest: MANIFEST,
    modelsDir: () => modelsDir,
    systemVersion: options.systemVersion ?? '14.5',
    readSwitch: () => switchOn,
    writeSwitch: (enabled) => {
      switchOn = enabled;
      writes.push(enabled);
    },
    download,
    pendingIndexComplete: async () => complete.value,
    pushConfig: async () => {
      pushes += 1;
      return true;
    },
    broadcast: (state) => states.push(state),
    log: () => undefined,
    pollMs: 60_000,
  });
  return {
    service,
    modelsDir,
    switchOn: () => switchOn,
    writes,
    states,
    download,
    pushCount: () => pushes,
    complete,
    finishDownload: () => finish(),
    failDownload: (err) => fail(err),
  };
}

describe('SearchModelService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'search-service-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('switching on downloads, then reports ready with the model it serves', async () => {
    const h = harness(root);

    await h.service.setEnabled(true);
    expect(h.service.getState().phase).toBe('downloading');
    expect(h.writes).toEqual([true]);

    h.finishDownload();
    await h.service.waitForRun();

    expect(h.service.getState().phase).toBe('ready');
    expect(h.service.getState().totalBytes).toBe(30);
    expect(h.service.getState().modelBytes).toBeGreaterThan(0);
    expect(h.service.daemonModels().model?.revision).toBe(MANIFEST.revision);
    expect(h.pushCount()).toBeGreaterThan(0);
  });

  it('a failed download switches the feature back off and keeps the reason', async () => {
    const h = harness(root);

    await h.service.setEnabled(true);
    h.failDownload(new DownloadHttpError(404, 'HTTP 404'));
    await h.service.waitForRun();

    expect(h.service.getState()).toMatchObject({
      phase: 'failed',
      reason: 'not-published',
      totalBytes: 30,
    });
    expect(h.writes).toEqual([true, false]);
    expect(h.switchOn()).toBe(false);
  });

  it('a failed update keeps the switch on and the model in use serving, and offers the update again with its reason', async () => {
    writeReadyModel(join(root, 'models'), 'oldrev0123456789');
    const h = harness(root, { switchOn: true });
    await h.service.start();
    await h.service.update();

    h.failDownload(new DownloadHttpError(500, 'HTTP 500'));
    await h.service.waitForRun();

    expect(h.service.getState()).toMatchObject({
      phase: 'update-available',
      reason: 'network',
    });
    expect(h.switchOn()).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.service.daemonModels()).toMatchObject({
      model: { revision: 'oldrev0123456789' },
      pendingModel: null,
    });
  });

  it('a Try again after a failure switches the feature back on and resumes the download', async () => {
    const h = harness(root);
    await h.service.setEnabled(true);
    h.failDownload(new DownloadHttpError(500, 'HTTP 500'));
    await h.service.waitForRun();

    await h.service.retry();

    expect(h.service.getState().phase).toBe('downloading');
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it('macOS 13 is unsupported: the switch stays disabled and nothing downloads', async () => {
    const h = harness(root, { systemVersion: '13.6.1' });

    await h.service.setEnabled(true);

    expect(h.service.getState()).toMatchObject({
      phase: 'unsupported',
      systemVersion: '13.6.1',
    });
    expect(h.download).not.toHaveBeenCalled();
  });

  it('a newer pinned model on disk waits for the user and keeps the old one serving', async () => {
    writeReadyModel(join(root, 'models'), 'oldrev0123456789');
    const h = harness(root, { switchOn: true });

    await h.service.start();

    expect(h.service.getState().phase).toBe('update-available');
    expect(h.service.getState().totalBytes).toBe(30);
    expect(h.service.daemonModels().model?.revision).toBe('oldrev0123456789');
    expect(h.download).not.toHaveBeenCalled();
  });

  it('an update keeps the old model until the daemon has indexed the new one', async () => {
    const oldDir = writeReadyModel(join(root, 'models'), 'oldrev0123456789');
    const h = harness(root, { switchOn: true });
    await h.service.start();

    await h.service.update();
    h.finishDownload();
    await h.service.waitForRun();

    expect(h.service.getState().phase).toBe('updating');
    expect(h.service.daemonModels()).toMatchObject({
      model: { revision: 'oldrev0123456789' },
      pendingModel: { revision: MANIFEST.revision },
    });

    await h.service.pollPending();
    expect(h.service.getState().phase).toBe('updating');
    expect(existsSync(oldDir)).toBe(true);

    h.complete.value = true;
    await h.service.pollPending();

    expect(h.service.getState().phase).toBe('ready');
    expect(h.service.daemonModels()).toMatchObject({
      model: { revision: MANIFEST.revision },
      pendingModel: null,
    });
    expect(existsSync(oldDir)).toBe(false);
  });

  it('deleting the model removes its folder and switches the feature off', async () => {
    writeReadyModel(join(root, 'models'), MANIFEST.revision);
    const h = harness(root, { switchOn: true });
    await h.service.start();
    expect(h.service.getState().phase).toBe('ready');

    await h.service.deleteModel();

    expect(h.service.getState().phase).toBe('off');
    expect(existsSync(join(root, 'models'))).toBe(false);
    expect(h.writes).toEqual([false]);
  });

  it('cancelling a download switches the feature off', async () => {
    const h = harness(root);
    await h.service.setEnabled(true);

    await h.service.cancel();

    expect(h.service.getState().phase).toBe('off');
    expect(h.writes).toEqual([true, false]);
  });
});
