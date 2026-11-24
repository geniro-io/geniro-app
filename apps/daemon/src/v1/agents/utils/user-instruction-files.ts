import { readFile, stat } from 'node:fs/promises';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapterRegistry } from '../services/agent-adapter.registry';
import { approxInstructionTokens } from './agent-instructions';

/** A file past this is reported as there but not measured. */
const MAX_MEASURED_FILE_BYTES = 1024 * 1024;

/** One agent's own standing-instructions file, as an analysis is told it. */
export interface UserInstructionFile {
  agent: AgentKind;
  /** The run's profile directory, or null for the CLI's default one. */
  configDir: string | null;
  /** Null when this CLI keeps no such file; `unavailableReason` says why. */
  path: string | null;
  unavailableReason?: string;
}

/** A {@link UserInstructionFile} with its size as it stands now. */
export interface SizedUserInstructionFile extends UserInstructionFile {
  /** Whether the file is there now; null for a CLI that keeps none. */
  exists: boolean | null;
  /** The file's own length — not what it imports; null when not measured. */
  chars: number | null;
  approxTokens: number | null;
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

/**
 * {@link userInstructionFiles}, each measured as it stands now: every one of
 * them reaches every turn its CLI takes, so its size is part of what a turn
 * carries before the prompt.
 */
export async function sizedUserInstructionFiles(
  registry: AgentAdapterRegistry,
  runners: readonly { agent: AgentKind; configDir: string | null }[],
): Promise<SizedUserInstructionFile[]> {
  return Promise.all(
    userInstructionFiles(registry, runners).map(async (file) => ({
      ...file,
      ...(file.path === null
        ? { exists: null, chars: null, approxTokens: null }
        : await sizeOfFile(file.path)),
    })),
  );
}

async function sizeOfFile(
  path: string,
): Promise<
  Pick<SizedUserInstructionFile, 'exists' | 'chars' | 'approxTokens'>
> {
  const { exists, text } = await readInstructionFile(path);
  return text === null
    ? { exists, chars: null, approxTokens: null }
    : {
        exists,
        chars: text.length,
        approxTokens: approxInstructionTokens(text.length),
      };
}

/**
 * An instruction file's text, or null when it is not there, is not a file, is
 * past {@link MAX_MEASURED_FILE_BYTES} or cannot be read; `exists` is null when
 * that could not be told.
 */
export async function readInstructionFile(
  path: string,
): Promise<{ exists: boolean | null; text: string | null }> {
  let size: number;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return { exists: false, text: null };
    }
    size = stats.size;
  } catch (error) {
    return {
      exists: (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null,
      text: null,
    };
  }
  if (size > MAX_MEASURED_FILE_BYTES) {
    return { exists: true, text: null };
  }
  try {
    return { exists: true, text: await readFile(path, 'utf8') };
  } catch {
    return { exists: true, text: null };
  }
}
