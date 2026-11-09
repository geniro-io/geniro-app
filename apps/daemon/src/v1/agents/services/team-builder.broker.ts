import { Injectable } from '@nestjs/common';

import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/**
 * Which team one builder-chat turn edits. The slug comes from the run
 * (`Run.editsTeamSlug`), never from the model: `save_team_change` and
 * `backup_team` act on that one file, and `propose_team` edits naming no other.
 */
export interface TeamBuilderSink {
  slug: string;
  /** The project whose overlay this chat edits beside the team (`Run.editsProjectId`); null in shared scope. */
  projectId: string | null;
  /**
   * When the turn began (epoch ms). The team editor does not save while the chat
   * works, so a file written after this, before the turn's own first check,
   * was written by something else.
   */
  turnStartedAt: number;
  /**
   * The file version this turn's last check read, or a refused one found;
   * null until then. A later check of the turn is held to it.
   */
  savedHash: string | null;
  /**
   * The turn's last check was refused because the file cannot be loaded, and
   * the agent repairs it itself: its next check takes the file as it stands.
   */
  acceptsAnyVersion: boolean;
}

/**
 * Gates `save_team_change` and `backup_team` to a team's own builder chat — the
 * chat docked under the team editor — and says what a `propose_team` naming no
 * team means there. A change is written by `TeamProposalService` behind the
 * proposal's card; the check is `TeamChangeService`'s, under its builder
 * authority.
 */
@Injectable()
export class TeamBuilderBroker extends HostSinkBroker<TeamBuilderSink> {
  canEdit(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  teamOf(
    runId: string,
    memberId: string,
  ): Promise<TeamBuilderSink | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no builder turn is running',
      'read the team this chat edits',
      (sink) => Promise.resolve({ ...sink }),
    );
  }

  /**
   * Remember what the turn now knows of the file, for its next check — only
   * on the turn that started at `turnStartedAt`: a check answering after its
   * turn ended (a Stop, then a new message) must not seed the next turn's.
   */
  async noteVersion(
    runId: string,
    memberId: string,
    turnStartedAt: number,
    known: Pick<TeamBuilderSink, 'savedHash' | 'acceptsAnyVersion'>,
  ): Promise<void> {
    await this.deliver(
      runId,
      memberId,
      'no builder turn is running',
      'note the team version',
      (sink) => {
        if (sink.turnStartedAt === turnStartedAt) {
          sink.savedHash = known.savedHash;
          sink.acceptsAnyVersion = known.acceptsAnyVersion;
        }
        return Promise.resolve();
      },
    );
  }
}
