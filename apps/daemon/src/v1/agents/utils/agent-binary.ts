import type { AgentKind } from '../../runs/runs.types';

/**
 * Env var carrying the user's Settings "cliPaths" override for each agent
 * binary. The UI passes these on the daemon spawn env (GENIRO_-prefixed, so
 * {@link buildChildEnv} strips them from every spawned child — the override is
 * resolved HERE in the daemon process and travels as the spawn command, never
 * as child env). Shared by the headless adapters and the PTY terminal path —
 * extracted, never mirrored.
 */
const OVERRIDE_ENV: Record<AgentKind, string> = {
  claude: 'GENIRO_CLAUDE_BIN',
  'cursor-agent': 'GENIRO_CURSOR_BIN',
};

/** The binary to spawn for an agent kind: the override path, else PATH lookup. */
export function resolveAgentBinary(kind: AgentKind): string {
  const override = process.env[OVERRIDE_ENV[kind]]?.trim();
  return override ? override : kind;
}
