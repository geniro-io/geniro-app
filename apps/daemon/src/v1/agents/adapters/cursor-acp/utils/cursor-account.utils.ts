import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURSOR_API_KEY_ENV,
  CURSOR_AUTH_FILE_NAME,
  CURSOR_AUTH_TOKEN_ENV,
  CURSOR_COMPILE_CACHE_PATH,
  CURSOR_CREDENTIAL_STORE_ENV,
  CURSOR_HOME_DIR_NAME,
  CURSOR_SEEDED_CONFIG_FILE,
} from '../cursor-acp.const';

export function cursorProfileAccountEnv(
  dir: string,
  realHome: string,
): Record<string, string> {
  return {
    HOME: dir,
    [CURSOR_CREDENTIAL_STORE_ENV]: 'file',
    NODE_COMPILE_CACHE: join(realHome, ...CURSOR_COMPILE_CACHE_PATH),
  };
}

/** Outside the memory store the CLI persists this token into the Keychain, replacing the default login. */
export function cursorProfileRunEnv(
  token: string | null,
): Record<string, string> {
  return {
    [CURSOR_CREDENTIAL_STORE_ENV]: 'memory',
    [CURSOR_API_KEY_ENV]: '',
    ...(token === null ? {} : { [CURSOR_AUTH_TOKEN_ENV]: token }),
  };
}

export function readCursorProfileToken(dir: string): string | null {
  const token = readJsonRecord(
    join(dir, CURSOR_HOME_DIR_NAME, CURSOR_AUTH_FILE_NAME),
  )?.['accessToken'];
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

export function readCursorProfileAuthInfo(
  dir: string,
): Record<string, unknown> | null {
  const info = readJsonRecord(
    join(dir, CURSOR_HOME_DIR_NAME, CURSOR_SEEDED_CONFIG_FILE),
  )?.['authInfo'];
  return isRecord(info) ? info : null;
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
