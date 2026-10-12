import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLAUDE_SYSTEM_PROMPT_FILE_MODE,
  CLAUDE_SYSTEM_PROMPT_FILE_PREFIX,
  CLAUDE_SYSTEM_PROMPT_FILE_SUFFIX,
} from '../claude.const';
import { ensurePrivateDir } from './claude-mcp-config.utils';

/** The process owns this private instruction file until it closes. */
export function writeTurnSystemPrompt(dir: string, prompt: string): string {
  ensurePrivateDir(dir);
  const path = join(
    dir,
    `${CLAUDE_SYSTEM_PROMPT_FILE_PREFIX}${randomUUID()}${CLAUDE_SYSTEM_PROMPT_FILE_SUFFIX}`,
  );
  try {
    writeFileSync(path, prompt, {
      encoding: 'utf8',
      mode: CLAUDE_SYSTEM_PROMPT_FILE_MODE,
      flag: 'wx',
    });
  } catch (err) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Keep the write failure; the next boot sweep can remove a leftover.
    }
    throw err;
  }
  return path;
}

/** Best-effort boot cleanup for a daemon crash that skipped process disposal. */
export function sweepStaleTurnSystemPrompts(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (
        name.startsWith(CLAUDE_SYSTEM_PROMPT_FILE_PREFIX) &&
        name.endsWith(CLAUDE_SYSTEM_PROMPT_FILE_SUFFIX)
      ) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // A missing directory or an unreadable entry must not block boot.
  }
}
