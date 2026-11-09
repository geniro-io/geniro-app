import { Injectable } from '@nestjs/common';

import { HostSinkBroker } from './host-sink.broker';

/**
 * Which project one project-chat turn belongs to. The id comes from the run
 * (`Run.editsProjectId`), never from the model.
 */
export interface ProjectChatSink {
  projectId: string;
}

/**
 * Says a turn is a project's own chat, and so what a call naming no project
 * means: `save_project_instructions` and an `overlay` on `propose_team` then
 * take this project. What the turn may change is the same as any chat's, each
 * behind a card the user answers.
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
}
