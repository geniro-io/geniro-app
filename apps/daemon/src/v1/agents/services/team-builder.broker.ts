import { Injectable } from '@nestjs/common';

import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/**
 * One builder-chat turn's standing to change its own team. The slug comes
 * from the run (`Run.editsTeamSlug`), never from the model, so the turn can
 * write to that one library file and no other.
 */
export interface TeamBuilderSink {
  slug: string;
  /**
   * When the turn began (epoch ms). The canvas does not save while the chat
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
 * Gates `propose_team`, `save_team_change`, `backup_team` and
 * `read_teams` for a team's own builder chat — the chat docked under
 * the canvas. A change is written by `TeamProposalService` behind the
 * proposal's card; the check is `TeamChangeService`'s, under its builder
 * authority.
 */
@Injectable()
export class TeamBuilderBroker extends HostSinkBroker<TeamBuilderSink> {
  canEdit(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  teamOf(
    runId: string,
    nodeId: string,
  ): Promise<TeamBuilderSink | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
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
    nodeId: string,
    turnStartedAt: number,
    known: Pick<TeamBuilderSink, 'savedHash' | 'acceptsAnyVersion'>,
  ): Promise<void> {
    await this.deliver(
      runId,
      nodeId,
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
