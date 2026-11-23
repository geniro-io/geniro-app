import { rm } from 'node:fs/promises';

import type { SearchModelState } from '../../shared/contracts';
import {
  dirBytes,
  DISCARD_PARTIALS,
  failureReasonOf,
  PAUSE_DOWNLOAD,
  type ReadyModel,
  readyModels,
  type SearchModelDownload,
  SearchModelFailure,
  type SearchModelManifest,
  type SearchModelProgress,
  totalBytesOf,
} from './search-model-downloader';

/** The first macOS major the model's runtime runs on. */
export const MIN_MACOS_MAJOR = 14;

/** How often a pending model is asked whether the daemon has indexed it. */
const POLL_MS = 30_000;

type RunKind = 'install' | 'update';

export type SearchModelLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, string>,
) => void;

export interface SearchModelServiceDeps {
  manifest: SearchModelManifest;
  /** `<userData>/models`, read when used: the service is built before the app's paths are set. */
  modelsDir: () => string;
  /** `process.getSystemVersion()`, e.g. `14.5`. */
  systemVersion: string;
  /** The `semanticSearch.enabled` switch, as settings.json holds it. */
  readSwitch: () => boolean;
  /** Writes the switch. Writing it sends no daemon config by itself. */
  writeSwitch: (enabled: boolean) => void;
  download: (
    manifest: SearchModelManifest,
    input: SearchModelDownload,
  ) => Promise<string>;
  /** Whether the daemon reports its pending model fully indexed. */
  pendingIndexComplete: () => Promise<boolean>;
  /** Hands the daemon the current models and the switch; true when it accepted them. */
  pushConfig: () => Promise<boolean>;
  broadcast: (state: SearchModelState) => void;
  log: SearchModelLog;
  pollMs?: number;
}

/**
 * The one place that decides what search by meaning is doing: the switch, the
 * model download, which folder is the active model and which one waits for the
 * daemon to index it. It owns a single {@link SearchModelState} and pushes it at
 * every window on every change.
 *
 * Two folders of one model id on disk means an update is pending: the old one
 * keeps serving until the daemon reports the new one indexed, and only then is
 * the old one deleted. Nothing else is stored, so a restart reads the same answer.
 */
export class SearchModelService {
  private state: SearchModelState;
  private active: ReadyModel | null = null;
  private pending: ReadyModel | null = null;
  private run: { controller: AbortController; done: Promise<void> } | null =
    null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: SearchModelServiceDeps) {
    const major = Number(deps.systemVersion.split('.')[0]);
    const unsupported = major < MIN_MACOS_MAJOR;
    this.state = {
      phase: unsupported ? 'unsupported' : 'off',
      receivedBytes: 0,
      totalBytes: unsupported ? 0 : totalBytesOf(deps.manifest),
      reason: null,
      systemVersion: unsupported ? deps.systemVersion : null,
      modelBytes: 0,
    };
  }

  getState(): SearchModelState {
    return this.state;
  }

  /** The models the daemon should search with, as the config push takes them. */
  daemonModels(): {
    model: ReadyModel | null;
    pendingModel: ReadyModel | null;
  } {
    return { model: this.active, pendingModel: this.pending };
  }

  /** Read the folders on disk and resume whatever the switch asks for. */
  async start(): Promise<SearchModelState> {
    if (this.state.phase !== 'unsupported') {
      await this.reconcile();
    }
    return this.state;
  }

  async setEnabled(enabled: boolean): Promise<SearchModelState> {
    if (this.state.phase === 'unsupported') {
      return this.state;
    }
    if (!enabled) {
      this.deps.writeSwitch(false);
      await this.pause(PAUSE_DOWNLOAD);
      this.set({
        phase: 'off',
        receivedBytes: 0,
        totalBytes: totalBytesOf(this.deps.manifest),
        reason: null,
      });
      await this.deps.pushConfig();
      return this.state;
    }
    if (isWorking(this.state.phase)) {
      return this.state;
    }
    this.deps.writeSwitch(true);
    await this.waitForRun();
    await this.reconcile();
    await this.deps.pushConfig();
    return this.state;
  }

  /** Stop the download, delete its partial files and switch search by meaning off. */
  async cancel(): Promise<SearchModelState> {
    if (this.state.phase === 'unsupported') {
      return this.state;
    }
    this.deps.writeSwitch(false);
    await this.pause(DISCARD_PARTIALS);
    this.set({
      phase: 'off',
      receivedBytes: 0,
      totalBytes: totalBytesOf(this.deps.manifest),
      reason: null,
    });
    await this.deps.pushConfig();
    return this.state;
  }

  /** Resume a failed download. The failure switched the feature off, so this switches it back on. */
  async retry(): Promise<SearchModelState> {
    if (this.state.phase !== 'failed') {
      return this.state;
    }
    return this.setEnabled(true);
  }

  /** Download the pinned model while the one in use keeps serving. */
  async update(): Promise<SearchModelState> {
    if (this.state.phase !== 'update-available') {
      return this.state;
    }
    this.startRun('update');
    return this.state;
  }

  /** Switch off, stop everything, and delete every model folder. */
  async deleteModel(): Promise<SearchModelState> {
    if (this.state.phase === 'unsupported') {
      return this.state;
    }
    this.deps.writeSwitch(false);
    await this.pause(DISCARD_PARTIALS);
    this.active = null;
    this.pending = null;
    await rm(this.deps.modelsDir(), { recursive: true, force: true });
    this.set({
      phase: 'off',
      receivedBytes: 0,
      totalBytes: totalBytesOf(this.deps.manifest),
      reason: null,
      modelBytes: 0,
    });
    await this.deps.pushConfig();
    return this.state;
  }

  /** Resolves once no download is running. Tests and the cancel path wait on it. */
  async waitForRun(): Promise<void> {
    await this.run?.done;
  }

  /** Ask the daemon once whether the pending model is indexed, and switch to it if so. */
  async pollPending(): Promise<void> {
    if (this.pending === null || this.polling) {
      return;
    }
    this.polling = true;
    try {
      if (await this.deps.pendingIndexComplete()) {
        await this.promote();
      }
    } finally {
      this.polling = false;
    }
  }

  private async reconcile(): Promise<void> {
    const { manifest } = this.deps;
    const ready = await readyModels(this.deps.modelsDir(), manifest.id);
    const current = ready.find((m) => m.revision === manifest.revision) ?? null;
    const older = ready.find((m) => m.revision !== manifest.revision) ?? null;
    if (current !== null && older !== null) {
      this.active = older;
      this.pending = current;
    } else {
      this.active = current ?? older;
      this.pending = null;
    }

    if (!this.deps.readSwitch()) {
      this.stopPoll();
      this.set({
        phase: 'off',
        receivedBytes: 0,
        totalBytes: totalBytesOf(this.deps.manifest),
        reason: null,
      });
    } else if (this.pending !== null) {
      this.startPoll();
      this.set({
        phase: 'updating',
        receivedBytes: totalBytesOf(manifest),
        totalBytes: totalBytesOf(manifest),
        reason: null,
      });
    } else if (this.active?.revision === manifest.revision) {
      this.set({
        phase: 'ready',
        receivedBytes: 0,
        totalBytes: totalBytesOf(manifest),
        reason: null,
      });
    } else if (this.active !== null) {
      this.set({
        phase: 'update-available',
        receivedBytes: 0,
        totalBytes: totalBytesOf(manifest),
        reason: null,
      });
    } else {
      this.startRun('install');
    }
    await this.refreshBytes();
  }

  private startRun(kind: RunKind): void {
    const controller = new AbortController();
    const done = this.runDownload(kind, controller.signal).finally(() => {
      if (this.run?.done === done) {
        this.run = null;
      }
    });
    this.run = { controller, done };
  }

  private async runDownload(kind: RunKind, signal: AbortSignal): Promise<void> {
    const { manifest } = this.deps;
    const total = totalBytesOf(manifest);
    const working = kind === 'install' ? 'downloading' : 'updating';
    let lastPercent = -1;
    this.set({
      phase: working,
      receivedBytes: 0,
      totalBytes: total,
      reason: null,
    });

    let ready: ReadyModel;
    try {
      await this.deps.download(manifest, {
        signal,
        onProgress: (progress) => {
          if (progress.phase === 'checking') {
            this.showProgress('checking', progress);
            return;
          }
          const percent = Math.floor(
            (progress.receivedBytes * 100) / progress.totalBytes,
          );
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.showProgress(working, progress);
          }
        },
      });
      ready = await this.readyFolder();
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      const reason = failureReasonOf(err);
      this.deps.log(
        'warn',
        `the search model download failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind: 'search-model-failed', reason },
      );
      if (kind === 'update') {
        this.set({
          phase: 'update-available',
          receivedBytes: 0,
          totalBytes: total,
          reason,
        });
        return;
      }
      this.deps.writeSwitch(false);
      this.set({
        phase: 'failed',
        receivedBytes: 0,
        totalBytes: total,
        reason,
      });
      await this.deps.pushConfig();
      return;
    }
    if (signal.aborted) {
      return;
    }

    if (kind === 'install') {
      this.active = ready;
      this.set({ phase: 'ready', receivedBytes: 0, totalBytes: total });
    } else {
      this.pending = ready;
      this.set({ phase: 'updating', receivedBytes: total, totalBytes: total });
      this.startPoll();
    }
    await this.refreshBytes();
    await this.deps.pushConfig();
  }

  private showProgress(
    phase: SearchModelState['phase'],
    progress: SearchModelProgress,
  ): void {
    this.set({
      phase,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
    });
  }

  private async readyFolder(): Promise<ReadyModel> {
    const { manifest } = this.deps;
    const found = (await readyModels(this.deps.modelsDir(), manifest.id)).find(
      (m) => m.revision === manifest.revision,
    );
    if (found === undefined) {
      throw new SearchModelFailure(
        'unknown',
        'the download finished without a ready model folder',
      );
    }
    return found;
  }

  private async promote(): Promise<void> {
    const old = this.active;
    const next = this.pending;
    if (next === null) {
      return;
    }
    this.stopPoll();
    this.active = next;
    this.pending = null;
    this.set({
      phase: 'ready',
      receivedBytes: 0,
      totalBytes: totalBytesOf(this.deps.manifest),
      reason: null,
    });
    const accepted = await this.deps.pushConfig();
    if (accepted && old !== null) {
      await rm(old.dir, { recursive: true, force: true });
    }
    await this.refreshBytes();
  }

  /** Abort the run, if any, and wait until its cleanup has finished. */
  private async pause(reason: string): Promise<void> {
    this.stopPoll();
    this.run?.controller.abort(reason);
    await this.waitForRun();
  }

  private startPoll(): void {
    if (this.poll !== null) {
      return;
    }
    this.poll = setInterval(() => {
      this.pollPending().catch((err: unknown) => {
        this.deps.log(
          'error',
          `the pending search model could not be checked: ${err instanceof Error ? err.message : String(err)}`,
          { kind: 'search-model-poll-failed' },
        );
      });
    }, this.deps.pollMs ?? POLL_MS);
    this.poll.unref?.();
  }

  private stopPoll(): void {
    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  private async refreshBytes(): Promise<void> {
    const modelBytes =
      this.active === null ? 0 : await dirBytes(this.active.dir);
    this.set({ modelBytes });
  }

  /** Merge a patch and push the state at every window — unless nothing about it changed. */
  private set(patch: Partial<SearchModelState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof SearchModelState)[]).some(
      (key) => next[key] !== this.state[key],
    );
    if (!changed) {
      return;
    }
    this.state = next;
    this.deps.broadcast(this.state);
  }
}

function isWorking(phase: SearchModelState['phase']): boolean {
  return (
    phase === 'downloading' || phase === 'checking' || phase === 'updating'
  );
}
