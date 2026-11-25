import { Injectable } from '@nestjs/common';

import type { HostPluginOutcome, HostPluginProposal } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/** Puts a proposed plugin on a card and resolves with the user's answer. */
export type PluginProposer = (
  proposal: HostPluginProposal,
  signal?: AbortSignal,
) => Promise<HostPluginOutcome>;

/** Writes an approved plugin; provided by `v1/plugins`, which `v1/agents` must not import. */
export type PluginWriter = (
  proposal: HostPluginProposal,
) => Promise<HostPluginOutcome>;

/** The rendezvous behind `save_plugin`'s card, and the seam its Approve writes through. */
@Injectable()
export class PluginProposalBroker extends HostSinkBroker<PluginProposer> {
  private writer: PluginWriter | null = null;

  useWriter(writer: PluginWriter): void {
    this.writer = writer;
  }

  write(proposal: HostPluginProposal): Promise<HostPluginOutcome> {
    return (
      this.writer?.(proposal) ??
      Promise.resolve({
        status: 'stale',
        reason: 'this daemon cannot write plugins',
      })
    );
  }

  canPropose(
    runId: string,
    memberId: string,
    conversationId: string | null = null,
  ): boolean {
    return this.offers(runId, memberId, conversationId);
  }

  answersAtOnce(runId: string, memberId: string): boolean {
    return this.sinkAnswersAtOnce(runId, memberId);
  }

  propose(
    runId: string,
    memberId: string,
    proposal: HostPluginProposal,
    signal?: AbortSignal,
  ): Promise<HostPluginOutcome> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could put it on screen',
      'propose a plugin',
      (proposer) => proposer(proposal, signal),
    );
  }
}
