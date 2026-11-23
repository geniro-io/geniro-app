import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { isPlainSessionId } from '../../../utils/session-id';
import type { AgentModelParameter } from '../../adapter.types';
import {
  CLAUDE_BASE_URL_ENV,
  CLAUDE_CODE_MODE_ENV_KEY,
  CLAUDE_CODE_MODE_ENV_VALUE,
  CLAUDE_CODE_MODE_MIN_MODEL,
  CLAUDE_CODE_MODE_MIN_VERSION,
  CLAUDE_CODE_MODE_OFF_VALUE,
  CLAUDE_CODE_MODE_ON_VALUE,
  CLAUDE_CODE_MODE_PARAMETER_ID,
  CLAUDE_CODE_MODE_SESSION_HEAD_BYTES,
  CLAUDE_CODE_MODE_SESSION_LINE_TYPE,
  CLAUDE_SESSION_FILE_SUFFIX,
  CLAUDE_SESSIONS_DIR_NAME,
  CLAUDE_THIRD_PARTY_PROVIDER_ENV_KEYS,
} from '../claude.const';
import { claudeProjectDirName } from './claude-sessions.utils';

/** The chip for Code Mode, disabled with `unavailableReason` when it cannot run. */
export function codeModeParameter(
  unavailableReason: string | null,
): AgentModelParameter {
  return {
    id: CLAUDE_CODE_MODE_PARAMETER_ID,
    label: 'Code mode',
    values: [
      {
        id: CLAUDE_CODE_MODE_ON_VALUE,
        label: 'On',
        description:
          'Experimental: the model writes one script that calls many tools',
      },
      { id: CLAUDE_CODE_MODE_OFF_VALUE, label: 'Off' },
    ],
    current: CLAUDE_CODE_MODE_OFF_VALUE,
    fixedPerSession: true,
    ...(unavailableReason === null ? {} : { unavailableReason }),
  };
}

export function wantsCodeMode(
  modelParameters: Record<string, string> | null | undefined,
): boolean {
  return (
    modelParameters?.[CLAUDE_CODE_MODE_PARAMETER_ID] ===
    CLAUDE_CODE_MODE_ON_VALUE
  );
}

/** The env entry a Code Mode turn adds to its `--settings` env block. */
export function codeModeEnv(): Record<string, string> {
  return { [CLAUDE_CODE_MODE_ENV_KEY]: CLAUDE_CODE_MODE_ENV_VALUE };
}

/**
 * Why this CLI build cannot run Code Mode headless, or null. An unreadable
 * version is not a refusal: a CLI that prints none can still work.
 */
export function codeModeVersionRefusal(version: string | null): string | null {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  const parts = match.slice(1, 4).map(Number);
  const gap = CLAUDE_CODE_MODE_MIN_VERSION.map(
    (min, i) => (parts[i] ?? 0) - min,
  ).find((difference) => difference !== 0);
  return gap === undefined || gap > 0
    ? null
    : `Code mode needs Claude Code ${CLAUDE_CODE_MODE_MIN_VERSION.join('.')} or later; this one is ${parts.join('.')}`;
}

/**
 * Why MODEL cannot run Code Mode, or null. Only a model whose name states a
 * generation older than the minimum is refused: a tier alias (`opus`) always
 * resolves to the latest model, and a name with no recognisable generation is
 * left to the CLI, whose own `code-mode-opt-in` notice reports a refusal.
 */
export function codeModeModelRefusal(model: string): string | null {
  const name = model.toLowerCase();
  const generation =
    name.match(
      /claude-(\d{1,2})(?:-(\d{1,2}))?-(?:opus|sonnet|haiku)(?![a-z])/,
    ) ??
    name.match(/(?:opus|sonnet|haiku)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/);
  if (!generation) {
    return null;
  }
  const major = Number(generation[1]);
  const minor = Number(generation[2] ?? 0);
  const [minMajor, minMinor] = CLAUDE_CODE_MODE_MIN_MODEL;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) {
    return null;
  }
  return `Code mode works on Claude ${minMajor}.${minMinor} models and later; ${model} is older`;
}

function isSet(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value.trim() !== '' &&
    value.trim() !== '0' &&
    value.trim().toLowerCase() !== 'false'
  );
}

/**
 * Why a turn whose env routes the CLI away from Anthropic's own endpoint cannot
 * run Code Mode, or null. `local` is true for a local (Ollama) model.
 */
export function codeModeRouteRefusal(
  env: Readonly<Record<string, string>>,
  local: boolean,
): string | null {
  if (local) {
    return 'Code mode does not run on local models';
  }
  if (CLAUDE_THIRD_PARTY_PROVIDER_ENV_KEYS.some((key) => isSet(env[key]))) {
    return "Code mode runs only on Anthropic's own API, not through Bedrock, Vertex or Foundry";
  }
  if (isSet(env[CLAUDE_BASE_URL_ENV])) {
    return "Code mode runs only on Anthropic's own API, not through a custom ANTHROPIC_BASE_URL";
  }
  return null;
}

/**
 * Whether the session a turn resumes was started in Code Mode, read off the
 * first line of its transcript; null when the transcript is not where the
 * folder files it, so the caller falls back to what the turn asked for.
 *
 * The CLI fixes Code Mode when a session starts, so this — not the setting a
 * team member, card or run configuration holds today — decides a resume: with
 * it off a Code Mode session exits 1, and turning it on later is ignored.
 */
export function sessionStartedInCodeMode(
  profileDir: string,
  sessionId: string,
  cwd: string,
): boolean | null {
  if (!isPlainSessionId(sessionId)) {
    return null;
  }
  const path = join(
    profileDir,
    CLAUDE_SESSIONS_DIR_NAME,
    claudeProjectDirName(cwd),
    `${sessionId}${CLAUDE_SESSION_FILE_SUFFIX}`,
  );
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(CLAUDE_CODE_MODE_SESSION_HEAD_BYTES);
    const read = readSync(fd, head, 0, head.length, 0);
    const firstLine = head.subarray(0, read).toString('utf8').split('\n', 1)[0];
    try {
      const line = JSON.parse(firstLine ?? '') as {
        type?: unknown;
        replMode?: unknown;
      };
      return (
        line.type === CLAUDE_CODE_MODE_SESSION_LINE_TYPE &&
        line.replMode === true
      );
    } catch {
      return false;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
