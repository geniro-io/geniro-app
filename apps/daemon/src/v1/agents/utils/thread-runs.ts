import type { Run } from '../../runs/entity/run.entity';
import { isAnalysisRun } from './analysed-runs';

type ThreadFacts = Pick<
  Run,
  | 'editsTeamSlug'
  | 'editsProjectId'
  | 'analysisSourceRunId'
  | 'analysisTeamSlug'
  | 'analysisPurpose'
>;

/**
 * Whether a run is a thread another thread may reach: a chat or a team run the
 * user works in, never a team-builder, project or analysis chat, which belong
 * to the page that opened them.
 */
export function isMessageableThread(run: ThreadFacts): boolean {
  return (
    run.editsTeamSlug === null &&
    run.editsProjectId === null &&
    !isAnalysisRun(run)
  );
}
