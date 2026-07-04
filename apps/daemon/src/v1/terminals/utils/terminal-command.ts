import { BadRequestException } from '@packages/common';

import { resolveAgentBinary } from '../../agents/utils/agent-binary';
import type { AgentKind } from '../../runs/runs.types';

/**
 * Resolve the interactive TUI invocation that mirrors an agent session. Claude
 * resumes the exact CLI session (`--resume <id>`) so the terminal shows the
 * same conversation the headless run produced; without a stored session id it
 * opens a fresh interactive session in the run's cwd. Cursor's subscription
 * TUI is an explicit M4 scope exclusion (deferred).
 */
export function terminalCommand(
  agentKind: AgentKind,
  resumeSessionId: string | null,
): { command: string; args: string[] } {
  if (agentKind === 'claude') {
    return {
      command: resolveAgentBinary('claude'),
      args: resumeSessionId ? ['--resume', resumeSessionId] : [],
    };
  }
  throw new BadRequestException(
    'TERMINAL_UNSUPPORTED',
    `no interactive terminal support for agent kind: ${agentKind}`,
  );
}
