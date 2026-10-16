import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapterRegistry } from '../services/agent-adapter.registry';

/** One agent's own standing-instructions file, as an analysis is told it. */
export interface UserInstructionFile {
  agent: AgentKind;
  /** The run's profile directory, or null for the CLI's default one. */
  configDir: string | null;
  /** Null when this CLI keeps no such file; `unavailableReason` says why. */
  path: string | null;
  unavailableReason?: string;
}

/**
 * The user-instruction file of each distinct (agent, profile) a thread ran
 * under, in first-seen order — what a `user`-target recommendation may edit.
 */
export function userInstructionFiles(
  registry: AgentAdapterRegistry,
  runners: readonly { agent: AgentKind; configDir: string | null }[],
): UserInstructionFile[] {
  const seen = new Set<string>();
  const files: UserInstructionFile[] = [];
  for (const { agent, configDir } of runners) {
    const key = `${agent}\u0000${configDir ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const file = registry.for(agent).userInstructionsFile(configDir);
    files.push(
      'path' in file
        ? { agent, configDir, path: file.path }
        : {
            agent,
            configDir,
            path: null,
            unavailableReason: file.unavailableReason,
          },
    );
  }
  return files;
}
