import type { AcpResumeContext } from '../../acp/acp-driver';
import { CURSOR_TRANSIENT_RESUME_PROMPT } from '../cursor-acp.const';
import { cursorDelegateReports } from './cursor-delegate-wake.utils';

/**
 * The prompt that carries a cursor turn on after its request was cut off —
 * `CURSOR_TRANSIENT_RESUME_PROMPT`, plus what the cut did to the sub-agents
 * it caught, which the agent has no way to see for itself.
 *
 * Two facts, each answering a way the agent wasted work on run `a8f5fb5f`:
 *
 * - **Still running.** The request died; the sub-agents it was waiting on did
 *   not. geniro now watches them and wakes the agent with their reports, so
 *   the agent is told not to launch them again and to end its turn once it has
 *   nothing to do without them. Relaunching them ran each one twice.
 * - **Finished, with results it never received.** The conversation the agent
 *   resumes is the server's last checkpoint, and results that came back after
 *   its last step are not in it. Their reports are handed over here, read off
 *   each sub-agent's own transcript; without them the agent ran all five again.
 */
export function cursorTransientResumePrompt(context: AcpResumeContext): string {
  const lines = [CURSOR_TRANSIENT_RESUME_PROMPT];
  if (context.finished.length > 0) {
    lines.push(
      '',
      context.finished.length === 1
        ? 'One sub-agent finished during the interrupted request, but its result never reached you. Its report is below — use it, and do not run it again.'
        : `${context.finished.length} sub-agents finished during the interrupted request, but their results never reached you. Their reports are below — use them, and do not run these again.`,
      '',
      ...cursorDelegateReports(context.finished),
    );
  }
  if (context.stillRunning.length > 0) {
    lines.push(
      '',
      context.stillRunning.length === 1
        ? 'One sub-agent you were waiting on is STILL RUNNING. The interruption cut off your `task` call, not the sub-agent:'
        : `${context.stillRunning.length} sub-agents you were waiting on are STILL RUNNING. The interruption cut off your \`task\` calls, not the sub-agents:`,
      ...context.stillRunning.map(
        (delegate, index) => `- ${delegate.label ?? `Sub-agent ${index + 1}`}`,
      ),
      '',
      'Do NOT launch these again. Their reports will be sent to you in a message as soon as they finish. Carry on with anything that does not need them, then end your turn; you will be prompted again with their results.',
    );
  }
  return lines.join('\n');
}
