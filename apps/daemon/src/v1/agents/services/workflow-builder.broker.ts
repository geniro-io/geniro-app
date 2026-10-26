import { Injectable } from '@nestjs/common';

import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/**
 * One builder-chat turn's standing to change its own workflow. The slug comes
 * from the run (`Run.editsWorkflowSlug`), never from the model, so the turn can
 * write to that one library file and no other.
 */
export interface WorkflowBuilderSink {
  slug: string;
  /**
   * When the turn began (epoch ms). The canvas does not save while the chat
   * works, so a file written after this, before the turn's own first save,
   * was written by something else.
   */
  turnStartedAt: number;
  /**
   * The file version this turn's last save wrote, or a refused save found;
   * null until then. A later save of the turn is checked against it.
   */
  savedHash: string | null;
  /**
   * The turn's last save was refused because the file cannot be loaded, and
   * the agent repairs it itself: its next save takes the file as it stands.
   */
  acceptsAnyVersion: boolean;
}

/**
 * Gates `save_workflow_change`, `backup_workflow` and `read_workflows` for a
 * workflow's own builder chat — the chat docked under the canvas. The writes
 * themselves are `WorkflowChangeService`'s, under its builder authority.
 */
@Injectable()
export class WorkflowBuilderBroker extends HostSinkBroker<WorkflowBuilderSink> {
  canEdit(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  workflowOf(
    runId: string,
    nodeId: string,
  ): Promise<WorkflowBuilderSink | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
      'no builder turn is running',
      'read the workflow this chat edits',
      (sink) => Promise.resolve({ ...sink }),
    );
  }

  /**
   * Remember what the turn now knows of the file, for its next save — only on
   * the turn that started at `turnStartedAt`: a save answering after its turn
   * ended (a Stop, then a new message) must not seed the next turn's check.
   */
  async noteVersion(
    runId: string,
    nodeId: string,
    turnStartedAt: number,
    known: Pick<WorkflowBuilderSink, 'savedHash' | 'acceptsAnyVersion'>,
  ): Promise<void> {
    await this.deliver(
      runId,
      nodeId,
      'no builder turn is running',
      'note the workflow version',
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
