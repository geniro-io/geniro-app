import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/**
 * One project-chat turn's standing to change its own project. Both ids come
 * from the run (`Run.editsProjectId`) and the project as it stood when the
 * turn began, never from the model.
 */
export interface ProjectChatSink {
  projectId: string;
  /** The project's default team, whose overlay for this project the turn may change; null when it defaults to an agent. */
  teamSlug: string | null;
}

/**
 * Gates what a project's own chat may change — the project's instruction
 * blocks (`save_project_instructions`) and its default team's overlay
 * (`propose_team`, overlay only) — each behind a card the user answers.
 */
@Injectable()
export class ProjectChatBroker extends HostSinkBroker<ProjectChatSink> {
  canEdit(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  /** The turn's project, or null outside a project chat's turn. */
  projectOf(runId: string, memberId: string): ProjectChatSink | null {
    const sink = this.sinkOf(runId, memberId);
    return sink === undefined ? null : { ...sink };
  }

  /** Whether the turn may propose an overlay: a project chat whose project defaults to a team. */
  canProposeOverlay(runId: string, memberId: string): boolean {
    return (this.sinkOf(runId, memberId)?.teamSlug ?? null) !== null;
  }
}
