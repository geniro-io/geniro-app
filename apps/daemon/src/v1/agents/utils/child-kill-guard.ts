import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

/** The kill guard's folder's name under the userData dir. */
export const KILL_GUARD_DIR_NAME = 'kill-guard';

/** More targets than this in one `kill` is refused. */
export const KILL_GUARD_TARGET_LIMIT = 60;

/** Present in every folder this module writes; how one guard recognises another. */
export const KILL_GUARD_MARKER_FILE = '.geniro-kill-guard';

/**
 * The ZDOTDIR and BASH_ENV the user had before the guard took both over.
 * Not `GENIRO_`-prefixed: `buildChildEnv` strips those, and a daemon started
 * from an agent's shell must still find the user's own startup files.
 */
export const KILL_GUARD_USER_ZDOTDIR_ENV = '__GENIRO_USER_ZDOTDIR';
export const KILL_GUARD_USER_BASH_ENV_ENV = '__GENIRO_USER_BASH_ENV';

const CHECK_FILE = 'kill-check';
const BIN_DIR = 'bin';
const ZSH_GUARD_FILE = 'kill-guard.zsh';
const BASH_ENV_FILE = 'bash-env';
const ZSH_STARTUP_FILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.zlogout',
] as const;

/**
 * What the guard runs once a kill passes. Production signals; a spec passes
 * a recorder for both, so no bug in the guard can reach a real signal.
 */
export interface KillGuardKills {
  /** The words of the in-shell call, each quoted as one shell word. */
  builtin: readonly string[];
  /** The program the PATH shim hands a passing kill to. */
  external: string;
}

export const REAL_KILLS: KillGuardKills = {
  builtin: ['builtin', 'kill'],
  external: '/bin/kill',
};

export interface KillGuardFile {
  content: string;
  executable: boolean;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function refusal(reason: string): string {
  return `refuse "${reason} Signal only PIDs you listed and checked."`;
}

function checkScript(): string {
  return [
    '#!/bin/sh',
    'refuse() {',
    `  printf 'geniro: refused kill: %s\\n' "$1" >&2`,
    '  exit 1',
    '}',
    `limit=${KILL_GUARD_TARGET_LIMIT}`,
    'count=0',
    'state=start',
    'set -f',
    'for arg in "$@"; do',
    '  case "$state" in',
    '    start)',
    '      case "$arg" in',
    '        -0) exit 0 ;;',
    '        -s|-n) state=signal; continue ;;',
    '        -l*|-L*) exit 0 ;;',
    '        --) state=targets; continue ;;',
    '        -?*) state=signalled; continue ;;',
    '      esac',
    '      state=targets ;;',
    '    signal)',
    '      [ "$arg" = 0 ] && exit 0',
    '      state=signalled; continue ;;',
    '    signalled)',
    '      state=targets',
    '      [ "$arg" = -- ] && continue ;;',
    '  esac',
    '  for target in $arg; do',
    '    count=$((count + 1))',
    '    sign=',
    '    digits=$target',
    '    case "$digits" in',
    '      +*) digits=${digits#+} ;;',
    '      -*) sign=-; digits=${digits#-} ;;',
    '    esac',
    `    case "$digits" in ''|*[!0-9]*) continue ;; esac`,
    '    while [ "${#digits}" -gt 1 ] && [ "${digits#0}" != "$digits" ]; do',
    '      digits=${digits#0}',
    '    done',
    '    case "$sign$digits" in',
    `      1) ${refusal('target $target is launchd (PID 1); signalling it ends every app on this Mac.')} ;;`,
    `      -1) ${refusal('target $target signals every process you own, every app included.')} ;;`,
    `      0|-0) ${refusal("target $target signals this shell's whole process group.")} ;;`,
    '    esac',
    '  done',
    'done',
    'if [ "$count" -gt "$limit" ]; then',
    `  ${refusal('$count targets in one kill (limit $limit); ps -p with -a, -x, -A or -e lists every process.')}`,
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

function killFunction(dir: string, kills: KillGuardKills): string {
  return `function kill { ${shellWord(join(dir, CHECK_FILE))} "$@" || return 1; ${kills.builtin.map(shellWord).join(' ')} "$@"; }`;
}

function zshGuard(dir: string, kills: KillGuardKills): string {
  const bin = shellWord(join(dir, BIN_DIR));
  return [
    'unalias kill 2>/dev/null',
    `path=(${bin} ${'${path:#'}${bin}})`,
    killFunction(dir, kills),
    '',
  ].join('\n');
}

function zshStartup(dir: string, name: string): string {
  const marker = KILL_GUARD_MARKER_FILE;
  return [
    `__geniro_guard=${shellWord(dir)}`,
    `__geniro_user="${'${'}${KILL_GUARD_USER_ZDOTDIR_ENV}:-$HOME}"`,
    `if [[ -e "$__geniro_user/${marker}" ]]; then __geniro_user="$HOME"; fi`,
    `if [[ -r "$__geniro_user/${name}" ]]; then`,
    '  ZDOTDIR="$__geniro_user"',
    `  source "$__geniro_user/${name}"`,
    `  if [[ "$ZDOTDIR" != "$__geniro_user" && ! -e "$ZDOTDIR/${marker}" ]]; then export ${KILL_GUARD_USER_ZDOTDIR_ENV}="$ZDOTDIR"; fi`,
    'fi',
    'ZDOTDIR="$__geniro_guard"',
    `source "$__geniro_guard/${ZSH_GUARD_FILE}"`,
    'unset __geniro_guard __geniro_user',
    '',
  ].join('\n');
}

function bashEnv(dir: string, kills: KillGuardKills): string {
  const bin = shellWord(join(dir, BIN_DIR));
  const user = KILL_GUARD_USER_BASH_ENV_ENV;
  return [
    `if [ -n "${'${'}${user}:-}" ] && [ -r "$${user}" ] && [ ! -e "${'${'}${user}%/*}/${KILL_GUARD_MARKER_FILE}" ]; then`,
    `  . "$${user}"`,
    'fi',
    `case "$PATH:" in ${bin}:*) ;; *) PATH=${bin}:"$PATH" ;; esac`,
    'unalias kill 2>/dev/null',
    killFunction(dir, kills),
    '',
  ].join('\n');
}

/**
 * Every file of a kill guard rooted at `dir`, by its path under `dir`.
 *
 * zsh reads `$ZDOTDIR/.zshenv` in every shell, `-c` included, so its startup
 * files source the user's own (under the user's ZDOTDIR) and then define a
 * `kill` function; bash's non-interactive shells read `BASH_ENV`. Each
 * function, and the PATH shim that catches `xargs kill`, hands the argv the
 * shell already expanded to one checker.
 */
export function killGuardFiles(
  dir: string,
  kills: KillGuardKills,
): Record<string, KillGuardFile> {
  const files: Record<string, KillGuardFile> = {
    [KILL_GUARD_MARKER_FILE]: { content: '1\n', executable: false },
    [CHECK_FILE]: { content: checkScript(), executable: true },
    [`${BIN_DIR}/kill`]: {
      content: [
        '#!/bin/sh',
        `${shellWord(join(dir, CHECK_FILE))} "$@" || exit 1`,
        `exec ${shellWord(kills.external)} "$@"`,
        '',
      ].join('\n'),
      executable: true,
    },
    [ZSH_GUARD_FILE]: { content: zshGuard(dir, kills), executable: false },
    [BASH_ENV_FILE]: { content: bashEnv(dir, kills), executable: false },
  };
  for (const name of ZSH_STARTUP_FILES) {
    files[name] = { content: zshStartup(dir, name), executable: false };
  }
  return files;
}

/** Write a guard into `dir`, each file through a rename, the marker last. */
export function writeKillGuard(dir: string, kills: KillGuardKills): void {
  const entries = Object.entries(killGuardFiles(dir, kills));
  entries.sort(
    ([a], [b]) =>
      Number(a === KILL_GUARD_MARKER_FILE) -
      Number(b === KILL_GUARD_MARKER_FILE),
  );
  mkdirSync(join(dir, BIN_DIR), { recursive: true });
  for (const [name, file] of entries) {
    const path = join(dir, name);
    const temporary = `${path}.${process.pid}.tmp`;
    const mode = file.executable ? 0o755 : 0o644;
    writeFileSync(temporary, file.content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  }
}

interface InstalledGuard {
  dir: string;
  kills: KillGuardKills;
  warned: boolean;
}

let installed: InstalledGuard | null = null;

const logger = new Logger('KillGuard');

/**
 * Write the guard into `dir` and start every child `buildChildEnv` builds
 * under it. A failed write is logged and leaves children unguarded, never
 * the daemon down. Returns the uninstall.
 */
export function installChildKillGuard(
  dir: string,
  kills: KillGuardKills = REAL_KILLS,
): () => void {
  const guard: InstalledGuard = { dir, kills, warned: false };
  installed = guard;
  try {
    writeKillGuard(dir, kills);
  } catch (err) {
    guard.warned = true;
    logger.warn(`could not write the kill guard in ${dir}: ${String(err)}`);
  }
  return () => {
    if (installed === guard) {
      installed = null;
    }
  };
}

function isGuardDir(dir: string | undefined): boolean {
  return (
    dir !== undefined &&
    dir !== '' &&
    existsSync(join(dir, KILL_GUARD_MARKER_FILE))
  );
}

function isGuardBashEnv(path: string | undefined): boolean {
  const suffix = `/${BASH_ENV_FILE}`;
  return (
    path !== undefined &&
    path.endsWith(suffix) &&
    isGuardDir(path.slice(0, -suffix.length))
  );
}

function presentGuard(): InstalledGuard | null {
  if (installed === null || isGuardDir(installed.dir)) {
    return installed;
  }
  try {
    writeKillGuard(installed.dir, installed.kills);
    return installed;
  } catch (err) {
    if (!installed.warned) {
      installed.warned = true;
      logger.warn(
        `could not rewrite the kill guard in ${installed.dir}: ${String(err)}`,
      );
    }
    return null;
  }
}

function userValue(
  current: string | undefined,
  currentIsGuard: boolean,
  carried: string | undefined,
): string | undefined {
  if (current !== undefined && current !== '' && !currentIsGuard) {
    return current;
  }
  return carried === undefined || carried === '' ? undefined : carried;
}

function withBinFirst(
  path: string | undefined,
  bin: string,
): string | undefined {
  if (path === undefined || path === '') {
    return undefined;
  }
  return path === bin || path.startsWith(`${bin}:`) ? path : `${bin}:${path}`;
}

/**
 * `env` with the installed guard's ZDOTDIR, BASH_ENV and PATH prefix, and
 * the user's own ZDOTDIR and BASH_ENV carried beside them; `env` itself when
 * no guard is installed or its files cannot be written.
 */
export function withChildKillGuard(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const guard = presentGuard();
  if (guard === null) {
    return env;
  }
  const userZdotdir = userValue(
    env.ZDOTDIR,
    isGuardDir(env.ZDOTDIR),
    env[KILL_GUARD_USER_ZDOTDIR_ENV],
  );
  const userBashEnv = userValue(
    env.BASH_ENV,
    isGuardBashEnv(env.BASH_ENV),
    env[KILL_GUARD_USER_BASH_ENV_ENV],
  );
  const result: NodeJS.ProcessEnv = {
    ...env,
    ZDOTDIR: guard.dir,
    BASH_ENV: join(guard.dir, BASH_ENV_FILE),
  };
  const path = withBinFirst(env.PATH, join(guard.dir, BIN_DIR));
  if (path === undefined) {
    delete result.PATH;
  } else {
    result.PATH = path;
  }
  delete result[KILL_GUARD_USER_ZDOTDIR_ENV];
  delete result[KILL_GUARD_USER_BASH_ENV_ENV];
  if (userZdotdir !== undefined) {
    result[KILL_GUARD_USER_ZDOTDIR_ENV] = userZdotdir;
  }
  if (userBashEnv !== undefined) {
    result[KILL_GUARD_USER_BASH_ENV_ENV] = userBashEnv;
  }
  return result;
}
