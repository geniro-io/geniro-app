import type { Run } from '../../runs/entity/run.entity';

/**
 * Whether a run is a project's own chat: bound to a project and to no team
 * file. A builder chat bound to a project before project chats existed keeps
 * its team slug and stays a builder chat.
 */
export function isProjectChat(
  run: Pick<Run, 'editsProjectId' | 'editsTeamSlug'>,
): run is Pick<Run, 'editsTeamSlug'> & { editsProjectId: string } {
  return run.editsProjectId !== null && run.editsTeamSlug === null;
}
