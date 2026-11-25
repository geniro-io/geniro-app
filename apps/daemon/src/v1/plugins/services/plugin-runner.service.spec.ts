import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import type { RunDao } from '../../agents/dao/run.dao';
import type { ProcessRegistry } from '../../agents/services/process-registry';
import type {
  ManagedCommandOptions,
  ManagedCommandResult,
} from '../../agents/utils/managed-command';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { PluginRunnerService } from './plugin-runner.service';
import { PluginStoreService } from './plugin-store.service';

const COMMAND = 'echo {"ok":true}';
const VIEW = [
  { id: 'root', component: 'Column', children: ['title'] },
  { id: 'title', component: 'Text', text: { '@path': '/title' } },
];
const TEN_MINUTES_MS = 600_000;

type RunRow = { id: string; cwd: string | null };

function result(
  change: Partial<ManagedCommandResult> = {},
): ManagedCommandResult {
  return {
    code: 0,
    stdout: '{"ok":true}',
    stderr: '',
    timedOut: false,
    output: '',
    ...change,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PluginRunnerService', () => {
  let root: string;
  let work: string;
  let other: string;
  let worktree: string;
  let store: PluginStoreService;
  let runs: Map<string, RunRow>;
  let rootOf: Map<string, string>;
  let calls: ManagedCommandOptions[];
  let respond: (
    options: ManagedCommandOptions,
  ) => Promise<ManagedCommandResult>;
  let runner: PluginRunnerService;

  const folder = async (name: string): Promise<string> => {
    await mkdir(join(root, name));
    return realpath(join(root, name));
  };

  const plugin = (change: Record<string, unknown> = {}): string =>
    stringify({
      name: 'Deploys',
      folders: [work],
      command: COMMAND,
      view: VIEW,
      ...change,
    });

  const approvedPlugin = (slug: string, change: Record<string, unknown> = {}) =>
    store.write(slug, plugin(change), { approve: true });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'geniro-plugin-run-'));
    work = await folder('work');
    other = await folder('other');
    worktree = await folder('worktree');
    store = new PluginStoreService({ pluginsDir: join(root, 'plugins') });
    runs = new Map<string, RunRow>([['run-1', { id: 'run-1', cwd: work }]]);
    rootOf = new Map();
    calls = [];
    respond = async () => result();

    const runDao = {
      getById: async (id: string) => runs.get(id) ?? null,
    } as unknown as RunDao;
    const roots = {
      rootsOf: async () => new Map(rootOf),
    } as unknown as ProjectRootsService;
    runner = new PluginRunnerService(
      store,
      {} as unknown as ProcessRegistry,
      runDao,
      roots,
    );
    runner.useCommandRunner((options) => {
      calls.push(options);
      return respond(options);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  describe('running a command', () => {
    it('refuses a run in a folder the plugin is not set to show in', async () => {
      await approvedPlugin('deploys');
      runs.set('run-2', { id: 'run-2', cwd: other });

      await expect(runner.run('deploys', 'run-2')).rejects.toMatchObject({
        errorCode: 'PLUGIN_FOLDER_MISMATCH',
      });
      expect(calls).toEqual([]);
    });

    it('runs the approved command in the run folder', async () => {
      await approvedPlugin('deploys');

      const run = await runner.run('deploys', 'run-1');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        label: 'plugin:deploys',
        command: '/bin/sh',
        args: ['-c', COMMAND],
        cwd: work,
      });
      expect(run).toMatchObject({
        data: { ok: true },
        error: null,
        exitCode: 0,
      });
    });

    it('matches every folder when the plugin lists none', async () => {
      await approvedPlugin('deploys', { folders: [] });
      runs.set('run-2', { id: 'run-2', cwd: other });

      await runner.run('deploys', 'run-2');

      expect(calls[0]?.cwd).toBe(other);
    });

    it('matches a card run in a task worktree through its project root', async () => {
      await approvedPlugin('deploys');
      runs.set('card-1', { id: 'card-1', cwd: worktree });
      rootOf.set(worktree, work);

      await runner.run('deploys', 'card-1');

      expect(calls).toHaveLength(1);
      expect(calls[0]?.cwd).toBe(worktree);
      expect(await runner.blocksForRun('card-1')).toMatchObject([
        { folder: worktree, folderName: 'work' },
      ]);
    });

    it('matches a listed folder that differs from the run folder only in case', async () => {
      await approvedPlugin('deploys', { folders: [work.toUpperCase()] });

      await runner.run('deploys', 'run-1');

      expect(calls).toHaveLength(1);
    });

    it('refuses a plugin file edited by hand until it is approved again', async () => {
      await approvedPlugin('deploys');
      await writeFile(
        join(root, 'plugins', 'deploys.plugin.yaml'),
        plugin({ command: 'echo changed' }),
      );

      await expect(runner.run('deploys', 'run-1')).rejects.toMatchObject({
        errorCode: 'PLUGIN_NOT_APPROVED',
      });
      expect(calls).toEqual([]);
    });

    it('refuses a switched-off plugin', async () => {
      await approvedPlugin('deploys', { enabled: false });

      await expect(runner.run('deploys', 'run-1')).rejects.toMatchObject({
        errorCode: 'PLUGIN_DISABLED',
      });
      expect(calls).toEqual([]);
    });

    it('refuses a run that has no folder to run in', async () => {
      await approvedPlugin('deploys');
      runs.set('no-folder', { id: 'no-folder', cwd: null });

      await expect(runner.run('deploys', 'no-folder')).rejects.toMatchObject({
        errorCode: 'PLUGIN_FOLDER_INVALID',
      });
      await expect(runner.run('deploys', 'missing-run')).rejects.toMatchObject({
        errorCode: 'PLUGIN_FOLDER_INVALID',
      });
      expect(calls).toEqual([]);
    });

    it('reports a run that timed out with no data', async () => {
      respond = async () => result({ code: null, stdout: '', timedOut: true });
      await approvedPlugin('deploys');

      const run = await runner.run('deploys', 'run-1');

      expect(run.data).toBeNull();
      expect(run.error).toContain('timed out');
    });

    it('reports output that is not JSON as an error and no data', async () => {
      respond = async () => result({ stdout: 'not json' });
      await approvedPlugin('deploys');

      const run = await runner.run('deploys', 'run-1');

      expect(run.data).toBeNull();
      expect(run.error).toMatch(/^the command did not print JSON/);
    });

    it('reports a non-zero exit as an error and no data', async () => {
      respond = async () => result({ code: 3, stdout: '', stderr: 'boom' });
      await approvedPlugin('deploys');

      const run = await runner.run('deploys', 'run-1');

      expect(run).toMatchObject({ data: null, error: 'exit 3', exitCode: 3 });
    });

    it('runs the command once for two calls at the same time', async () => {
      const started = deferred<void>();
      const gate = deferred<ManagedCommandResult>();
      respond = () => {
        started.resolve();
        return gate.promise;
      };
      await approvedPlugin('deploys');

      const first = runner.run('deploys', 'run-1');
      await started.promise;
      const second = runner.run('deploys', 'run-1');
      gate.resolve(result({ stdout: '{"n":1}' }));

      const [a, b] = await Promise.all([first, second]);
      expect(calls).toHaveLength(1);
      expect(b).toBe(a);
    });
  });

  describe('running in a folder the user picks', () => {
    it('runs the approved command in that folder', async () => {
      await approvedPlugin('deploys');

      const run = await runner.runInFolder('deploys', work, { force: true });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        label: 'plugin:deploys',
        args: ['-c', COMMAND],
        cwd: work,
      });
      expect(run).toMatchObject({ data: { ok: true }, error: null });
    });

    it('fills the result a chat in that folder shows', async () => {
      await approvedPlugin('deploys');

      const run = await runner.runInFolder('deploys', work);
      const [block] = await runner.blocksForRun('run-1');

      expect(block?.result).toEqual(run);
    });

    it('refuses a folder the plugin is not set to show in', async () => {
      await approvedPlugin('deploys');

      await expect(runner.runInFolder('deploys', other)).rejects.toMatchObject({
        errorCode: 'PLUGIN_FOLDER_MISMATCH',
      });
      expect(calls).toEqual([]);
    });

    it('refuses a folder that does not exist', async () => {
      await approvedPlugin('deploys', { folders: [] });

      await expect(
        runner.runInFolder('deploys', join(root, 'gone')),
      ).rejects.toMatchObject({ errorCode: 'PLUGIN_FOLDER_INVALID' });
      expect(calls).toEqual([]);
    });

    it('refuses a plugin file edited by hand until it is approved again', async () => {
      await approvedPlugin('deploys');
      await writeFile(
        join(root, 'plugins', 'deploys.plugin.yaml'),
        plugin({ command: 'echo {"changed":true}' }),
      );

      await expect(runner.runInFolder('deploys', work)).rejects.toMatchObject({
        errorCode: 'PLUGIN_NOT_APPROVED',
      });
      expect(calls).toEqual([]);
    });
  });

  describe('caching', () => {
    it('serves a second run inside refresh_minutes from the cache, and runs again after it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
      await approvedPlugin('deploys');
      const first = await runner.run('deploys', 'run-1');

      vi.setSystemTime(new Date('2026-11-25T10:04:00Z'));
      expect(await runner.run('deploys', 'run-1')).toEqual(first);
      expect(calls).toHaveLength(1);

      vi.setSystemTime(new Date('2026-11-25T10:06:00Z'));
      await runner.run('deploys', 'run-1');
      expect(calls).toHaveLength(2);
    });

    it('runs a forced run every time, even seconds after the last one', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
      await approvedPlugin('deploys');
      await runner.run('deploys', 'run-1');

      vi.setSystemTime(new Date('2026-11-25T10:00:05Z'));
      await runner.run('deploys', 'run-1', { force: true });
      vi.setSystemTime(new Date('2026-11-25T10:00:10Z'));
      await runner.run('deploys', 'run-1', { force: true });

      expect(calls).toHaveLength(3);
    });

    it('joins a run already in flight for a forced run instead of starting a second', async () => {
      const gate = deferred<ManagedCommandResult>();
      respond = () => gate.promise;
      await approvedPlugin('deploys');
      const first = runner.run('deploys', 'run-1');
      await vi.waitFor(() => expect(calls).toHaveLength(1));

      const read = vi.spyOn(store, 'getOrThrow');
      const forced = runner.run('deploys', 'run-1', { force: true });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await read.mock.results[0]?.value;
      gate.resolve(result());

      expect(await forced).toEqual(await first);
      expect(calls).toHaveLength(1);
    });

    it('runs a timer refresh that arrives on the minute although the last run ended later than it started', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
      respond = async () => {
        vi.setSystemTime(new Date(Date.now() + 15));
        return result();
      };
      await approvedPlugin('deploys', { refresh_minutes: 1 });
      await runner.run('deploys', 'run-1');

      vi.setSystemTime(new Date('2026-11-25T10:00:30.000Z'));
      await runner.run('deploys', 'run-1');
      expect(calls).toHaveLength(1);

      vi.setSystemTime(new Date('2026-11-25T10:01:00.000Z'));
      await runner.run('deploys', 'run-1');
      expect(calls).toHaveLength(2);
    });

    it('gives the Settings list the newest result in any folder, its error included', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await approvedPlugin('deploys', { folders: [] });
      runs.set('run-2', { id: 'run-2', cwd: other });
      expect(runner.lastRun('deploys')).toBeNull();

      vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
      await runner.run('deploys', 'run-1');
      vi.setSystemTime(new Date('2026-11-25T10:01:00Z'));
      respond = async () => result({ code: 3, stdout: '' });
      await runner.run('deploys', 'run-2');

      expect(runner.lastRun('deploys')).toMatchObject({
        at: '2026-11-25T10:01:00.000Z',
        error: 'exit 3',
      });
    });
  });

  describe('blocksForRun', () => {
    it('lists only the enabled plugins that match the run folder, with their last result', async () => {
      await approvedPlugin('deploys');
      await approvedPlugin('quiet', { name: 'Quiet' });
      await approvedPlugin('off', { enabled: false });
      await approvedPlugin('elsewhere', { folders: [other] });
      await runner.run('deploys', 'run-1');

      const blocks = await runner.blocksForRun('run-1');

      expect(blocks.map((block) => block.slug)).toEqual(['deploys', 'quiet']);
      expect(blocks[0]).toMatchObject({
        folder: work,
        state: 'approved',
        result: { data: { ok: true } },
      });
      expect(blocks[1]?.result).toBeNull();
    });

    it('lists none for a run with no folder', async () => {
      await approvedPlugin('deploys');
      runs.set('no-folder', { id: 'no-folder', cwd: null });

      expect(await runner.blocksForRun('no-folder')).toEqual([]);
    });
  });

  describe('pressing a button', () => {
    it('hands the button the values the cached data holds at its env pointers', async () => {
      respond = async (options) =>
        options.label.startsWith('plugin-button:')
          ? result({ stdout: '', output: 'pressed\n' })
          : result({
              stdout: JSON.stringify({ title: 'Build 7', stats: { count: 3 } }),
            });
      await approvedPlugin('deploys', {
        buttons: [
          {
            id: 'retry',
            command: 'echo retry',
            env: { PLUGIN_TITLE: '/title', PLUGIN_COUNT: '/stats/count' },
          },
        ],
      });
      const seen = await runner.run('deploys', 'run-1');

      const pressed = await runner.press('deploys', 'retry', 'run-1', seen.at);

      expect(calls.at(-1)).toMatchObject({
        label: 'plugin-button:deploys:retry',
        command: '/bin/sh',
        args: ['-c', 'echo retry'],
        cwd: work,
        timeoutMs: TEN_MINUTES_MS,
        env: { PLUGIN_TITLE: 'Build 7', PLUGIN_COUNT: '3' },
      });
      expect(pressed).toEqual({
        exitCode: 0,
        outputTail: 'pressed\n',
        error: null,
      });
    });

    it('refuses a press whose env pointer finds nothing in the data with PLUGIN_NO_DATA', async () => {
      await approvedPlugin('deploys', {
        buttons: [
          {
            id: 'retry',
            command: 'echo retry',
            env: { PLUGIN_TITLE: '/title' },
          },
        ],
      });
      const seen = await runner.run('deploys', 'run-1');

      await expect(
        runner.press('deploys', 'retry', 'run-1', seen.at),
      ).rejects.toMatchObject({ errorCode: 'PLUGIN_NO_DATA' });
      expect(calls).toHaveLength(1);
    });

    it('refuses a press once the data has been refreshed past the result the user saw', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
      await approvedPlugin('deploys', {
        buttons: [{ id: 'retry', command: 'echo retry' }],
      });
      const seen = await runner.run('deploys', 'run-1');
      vi.setSystemTime(new Date('2026-11-25T10:02:00Z'));
      const refreshed = await runner.run('deploys', 'run-1', { force: true });
      expect(refreshed.at).not.toBe(seen.at);

      await expect(
        runner.press('deploys', 'retry', 'run-1', seen.at),
      ).rejects.toMatchObject({ errorCode: 'PLUGIN_DATA_CHANGED' });
      expect(
        calls.filter((call) => call.label.startsWith('plugin-button')),
      ).toEqual([]);
    });

    it('refuses a second press of a button that is still running with PLUGIN_BUSY', async () => {
      const started = deferred<void>();
      const gate = deferred<ManagedCommandResult>();
      respond = (options) => {
        if (options.label.startsWith('plugin-button:')) {
          started.resolve();
          return gate.promise;
        }
        return Promise.resolve(result());
      };
      await approvedPlugin('deploys', {
        buttons: [{ id: 'retry', command: 'echo retry' }],
      });
      const seen = await runner.run('deploys', 'run-1');

      const first = runner.press('deploys', 'retry', 'run-1', seen.at);
      await started.promise;
      await expect(
        runner.press('deploys', 'retry', 'run-1', seen.at),
      ).rejects.toMatchObject({ errorCode: 'PLUGIN_BUSY' });

      gate.resolve(result({ output: 'done\n' }));
      await expect(first).resolves.toMatchObject({
        exitCode: 0,
        outputTail: 'done\n',
      });
    });

    it('returns the end of the button output, cut to its last 4096 characters', async () => {
      const output = `head ${'x'.repeat(5000)} end`;
      respond = async (options) =>
        options.label.startsWith('plugin-button:')
          ? result({ stdout: '', output })
          : result();
      await approvedPlugin('deploys', {
        buttons: [{ id: 'retry', command: 'echo retry' }],
      });
      const seen = await runner.run('deploys', 'run-1');

      const pressed = await runner.press('deploys', 'retry', 'run-1', seen.at);

      expect(pressed.outputTail).toBe(output.slice(-4096));
    });

    it('refuses a press on data an earlier text of the file produced', async () => {
      await approvedPlugin('deploys', {
        buttons: [{ id: 'retry', command: 'echo retry' }],
      });
      const seen = await runner.run('deploys', 'run-1');
      await approvedPlugin('deploys', {
        command: 'echo {"other":true}',
        buttons: [{ id: 'retry', command: 'echo retry' }],
      });

      await expect(
        runner.press('deploys', 'retry', 'run-1', seen.at),
      ).rejects.toMatchObject({ errorCode: 'PLUGIN_DATA_CHANGED' });
      expect(
        calls.filter((call) => call.label.startsWith('plugin-button')),
      ).toEqual([]);
    });

    it('refreshes after a press with a run that starts after the press, even with one in flight', async () => {
      const inFlight = deferred<ManagedCommandResult>();
      let dataRuns = 0;
      respond = (options) => {
        if (options.label.startsWith('plugin-button:')) {
          return Promise.resolve(result({ stdout: '', output: 'ok\n' }));
        }
        dataRuns += 1;
        return dataRuns === 2
          ? inFlight.promise
          : Promise.resolve(result({ stdout: `{"run":${dataRuns}}` }));
      };
      await approvedPlugin('deploys', {
        buttons: [{ id: 'retry', command: 'echo retry' }],
      });
      const seen = await runner.run('deploys', 'run-1');
      const timer = runner.run('deploys', 'run-1', { skipCache: true });

      await runner.press('deploys', 'retry', 'run-1', seen.at);
      inFlight.resolve(result({ stdout: '{"run":2}' }));
      await timer;
      await vi.waitFor(() => expect(dataRuns).toBe(3));
      await vi.waitFor(async () =>
        expect((await runner.blocksForRun('run-1'))[0]?.result?.data).toEqual({
          run: 3,
        }),
      );
    });
  });

  it('keeps no result from a run that was in flight when its plugin was forgotten', async () => {
    const gate = deferred<ManagedCommandResult>();
    respond = () => gate.promise;
    await approvedPlugin('deploys');
    const pending = runner.run('deploys', 'run-1');
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    runner.forget('deploys');
    gate.resolve(result());
    await pending;

    expect((await runner.blocksForRun('run-1'))[0]?.result).toBeNull();
  });
});
