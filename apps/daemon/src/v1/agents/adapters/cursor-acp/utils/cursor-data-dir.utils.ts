import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

import {
  CURSOR_DATA_DIR_ENV,
  CURSOR_DATA_DIR_PREFIX,
  CURSOR_HOME_DIR_NAME,
  CURSOR_MCP_DISABLED_FILE,
  CURSOR_PROJECT_STATE_DIRS,
  CURSOR_PROJECT_STATE_FILES,
  CURSOR_PROJECTS_DIR_NAME,
} from '../cursor-acp.const';
import { cursorProjectKey } from './cursor-delegate-transcript.utils';

/** What one turn's throwaway data directory is built from. */
export interface CursorDataDirSeed {
  /** Directory the throwaway data directories are created in. */
  baseDir: string;
  /** The turn's working directory — the CLI's `process.cwd()`. */
  cwd: string;
  /** The servers this turn runs without, ADDED to the user's own list. */
  disabled: readonly string[];
  /** The user's home (test seam). */
  homeDir?: string;
  /** The daemon's environment, for a `CURSOR_DATA_DIR` the user set (test seam). */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The folder the CLI files a workspace's MCP state under: the nearest
 * ancestor holding a `.git` entry (file or directory), else the folder itself.
 *
 * Transcribed from cursor-agent 2026.10.01-e373342 (`./src/utils/git.ts`'s
 * `p`): it walks up while `<dir>/.git` does not exist and stops BEFORE the
 * filesystem root, which it never checks.
 */
export function cursorProjectRoot(cwd: string): string {
  const root = parse(cwd).root;
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir || up === root) {
      return cwd;
    }
    dir = up;
  }
}

/** `path` with its links resolved, or as given when it cannot be. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The user's own disabled list for a workspace, or none. Never throws. */
function readDisabled(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * A throwaway `CURSOR_DATA_DIR` for ONE turn whose `mcp-disabled.json` adds a
 * workflow node's switched-off servers to the user's own — the only per-turn
 * MCP switch this CLI has.
 *
 * **Where the list lives.** cursor-agent keeps a workspace's disabled servers,
 * MCP sign-ins and approvals at `<CURSOR_DATA_DIR or ~/.cursor>/projects/<key
 * of the project root>/` (`../cursor-config/dist/paths.js` and
 * `./src/mcp/project-paths.ts` in the 2026.10.01-e373342 bundle), and the ACP
 * server builds its MCP loader from exactly that (`C(process.cwd())` →
 * `disabledPath`, `mcp-auth.json`, `mcp-approvals.json`). Nothing else reads
 * the data directory: delegate transcripts and terminal output go under
 * `projects/<key of the cwd>/` of the same directory, and the worker command is
 * the only other reader of the variable.
 *
 * **What this builds.** `<dir>/projects/<root key>/` is a REAL directory whose
 * every entry is a symlink into the user's real one — sign-ins, approvals,
 * transcripts, terminals — except `mcp-disabled.json`, which is this turn's
 * own: the user's list plus the node's. Names the CLI writes and that do not
 * exist yet are linked anyway ({@link CURSOR_PROJECT_STATE_FILES} /
 * {@link CURSOR_PROJECT_STATE_DIRS}), so a sign-in refreshed mid-turn lands in
 * the real `mcp-auth.json`. When the cwd is not the project root, its own key
 * is linked whole: nothing there decides which servers load.
 *
 * **Measured** on 2026.10.01-e373342, `cursor-agent mcp list` in this repo
 * (the same `project-paths` call the ACP server makes): under such a directory
 * with `["codegraph","playwright"]`, both listed `disabled` while `datadog` —
 * signed in through OAuth — stayed `ready`; under an EMPTY data directory
 * `datadog` read `requires_authentication`, which is what the links buy. The
 * real project directory was untouched.
 *
 * **What is lost**, and why it is acceptable: a file the CLI writes under the
 * workspace directory that is neither already there nor on the lists above is
 * written into the throwaway and goes with it. The lists are every name the
 * bundle writes there today; a new one costs that file for one turn's process,
 * never the user's settings.
 */
export function seedCursorDataDir(seed: CursorDataDirSeed): string {
  const env = seed.env ?? process.env;
  const realData =
    env[CURSOR_DATA_DIR_ENV]?.trim() ||
    join(seed.homeDir ?? homedir(), CURSOR_HOME_DIR_NAME);
  const realProjects = join(realData, CURSOR_PROJECTS_DIR_NAME);
  // The CLI keys by `process.cwd()`, which the kernel answers with the REAL
  // path (`/private/var/…` for a `/var/…` folder), so the keys are taken from
  // the same reading.
  const cwd = realPath(seed.cwd);
  const projectRoot = cursorProjectRoot(cwd);
  const rootKey = cursorProjectKey(projectRoot);
  const cwdKey = cursorProjectKey(cwd);

  mkdirSync(seed.baseDir, { recursive: true });
  const dir = mkdtempSync(join(seed.baseDir, CURSOR_DATA_DIR_PREFIX));
  const projects = join(dir, CURSOR_PROJECTS_DIR_NAME);
  const own = join(projects, rootKey);
  mkdirSync(own, { recursive: true });

  const realOwn = join(realProjects, rootKey);
  // The real directory must exist for a dangling file link to be written
  // through; the CLI creates it on its own first use anyway.
  mkdirSync(realOwn, { recursive: true });
  for (const name of CURSOR_PROJECT_STATE_DIRS) {
    mkdirSync(join(realOwn, name), { recursive: true });
  }
  const linked = new Set<string>([
    ...readdirSync(realOwn),
    ...CURSOR_PROJECT_STATE_FILES,
  ]);
  linked.delete(CURSOR_MCP_DISABLED_FILE);
  for (const name of linked) {
    symlinkSync(join(realOwn, name), join(own, name));
  }
  const disabled = [
    ...new Set([
      ...readDisabled(join(realOwn, CURSOR_MCP_DISABLED_FILE)),
      ...seed.disabled,
    ]),
  ];
  writeFileSync(
    join(own, CURSOR_MCP_DISABLED_FILE),
    JSON.stringify(disabled, null, 2),
  );

  if (cwdKey !== rootKey) {
    const realCwd = join(realProjects, cwdKey);
    mkdirSync(realCwd, { recursive: true });
    symlinkSync(realCwd, join(projects, cwdKey));
  }
  return dir;
}
