import { BadRequestException } from '@packages/common';

import { resolveAgentBinary } from '../../agents/utils/agent-binary';
import type { AgentKind } from '../../runs/runs.types';

/**
 * Resolve the interactive TUI invocation that mirrors an agent session. Claude
 * resumes the exact CLI session (`--resume <id>`) so the terminal shows the
 * same conversation the headless run produced. A missing session id is not a
 * mirror target and must fail instead of opening an unrelated fresh TUI.
 * Cursor's subscription TUI is an explicit M4 scope exclusion (deferred).
 */
export function terminalCommand(
  agentKind: AgentKind,
  resumeSessionId: string | null,
): { command: string; args: string[] } {
  if (agentKind === 'claude') {
    const sessionId = resumeSessionId?.trim();
    if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) {
      throw new BadRequestException(
        'TERMINAL_SESSION_UNAVAILABLE',
        'the agent has not produced a resumable terminal session yet',
      );
    }
    return {
      command: resolveAgentBinary('claude'),
      args: ['--resume', sessionId],
    };
  }
  throw new BadRequestException(
    'TERMINAL_UNSUPPORTED',
    `no interactive terminal support for agent kind: ${agentKind}`,
  );
}
