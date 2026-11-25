import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BaseException } from '@packages/common';

import type {
  HostPluginOutcome,
  HostPluginProposal,
} from '../../agents/chat.types';
import { PluginProposalBroker } from '../../agents/services/plugin-proposal.broker';
import {
  type PluginBlockList,
  type PluginDetail,
  type PluginList,
  type PluginPressResult,
  type PluginRunResult,
  type PluginSummary,
  type StoredPlugin,
} from '../plugins.types';
import { withPluginSettings } from '../utils/plugin-file';
import { PluginRunnerService } from './plugin-runner.service';
import { PluginStoreService } from './plugin-store.service';

/** What the plugin routes do: the store's reads and the user's writes, and the runner's runs. */
@Injectable()
export class PluginsService implements OnModuleInit {
  constructor(
    private readonly store: PluginStoreService,
    private readonly runner: PluginRunnerService,
    private readonly proposals: PluginProposalBroker,
  ) {}

  onModuleInit(): void {
    this.proposals.useWriter((proposal) => this.saveApproved(proposal));
  }

  /** A `save_plugin` card's Approve: the file and its approved copy, or why not. */
  async saveApproved(proposal: HostPluginProposal): Promise<HostPluginOutcome> {
    try {
      await this.store.write(proposal.slug, proposal.text, {
        baseHash: proposal.baseHash,
        approve: true,
      });
      this.runner.forget(proposal.slug);
      return {
        status: 'saved',
        slug: proposal.slug,
        path: this.store.pathOf(proposal.slug),
      };
    } catch (error) {
      if (error instanceof BaseException) {
        return { status: 'stale', reason: error.message };
      }
      throw error;
    }
  }

  async list(): Promise<PluginList> {
    const plugins = await this.store.list();
    return { plugins: plugins.map((stored) => this.summaryOf(stored)) };
  }

  async detail(slug: string): Promise<PluginDetail> {
    const stored = await this.store.getOrThrow(slug);
    return {
      slug,
      text: stored.text,
      approvedText: stored.approvedText,
      hash: stored.hash,
      state: stored.state,
      error: stored.error,
      path: this.store.pathOf(slug),
    };
  }

  async blocksForRun(runId: string): Promise<PluginBlockList> {
    return { blocks: await this.runner.blocksForRun(runId) };
  }

  run(slug: string, runId: string, force: boolean): Promise<PluginRunResult> {
    return this.runner.run(slug, runId, { force });
  }

  runInFolder(
    slug: string,
    folder: string,
    force: boolean,
  ): Promise<PluginRunResult> {
    return this.runner.runInFolder(slug, folder, { force });
  }

  press(
    slug: string,
    buttonId: string,
    runId: string,
    dataAt: string,
  ): Promise<PluginPressResult> {
    return this.runner.press(slug, buttonId, runId, dataAt);
  }

  async approve(slug: string, hash: string): Promise<PluginSummary> {
    const approved = await this.store.approve(slug, hash);
    this.runner.forget(slug);
    return this.summaryOf(approved);
  }

  async patch(
    slug: string,
    change: { enabled?: boolean; folders?: string[]; baseHash: string },
  ): Promise<PluginSummary> {
    const { baseHash, ...settings } = change;
    const updated = await this.store.update(slug, baseHash, (text) =>
      withPluginSettings(text, settings),
    );
    this.runner.forget(slug);
    return this.summaryOf(updated);
  }

  async delete(slug: string): Promise<boolean> {
    const removed = await this.store.delete(slug);
    this.runner.forget(slug);
    return removed;
  }

  private summaryOf(stored: StoredPlugin): PluginSummary {
    const plugin = stored.plugin;
    const lastRun = this.runner.lastRun(stored.slug);
    return {
      slug: stored.slug,
      name: plugin?.name ?? null,
      enabled: plugin?.enabled ?? false,
      folders: plugin?.folders ?? [],
      refreshMinutes: plugin?.refresh_minutes ?? 0,
      command: plugin?.command ?? null,
      buttons: (plugin?.buttons ?? []).map(({ id, command, confirm }) => ({
        id,
        command,
        confirm,
      })),
      state: stored.state,
      error: stored.error,
      hash: stored.hash,
      path: this.store.pathOf(stored.slug),
      lastRunAt: lastRun?.at ?? null,
      lastRunError: lastRun?.error ?? null,
    };
  }
}
