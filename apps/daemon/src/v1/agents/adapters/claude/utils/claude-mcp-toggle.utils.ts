import {
  CLAUDE_DISABLED_MCP_SERVERS_KEY,
  CLAUDE_HOME_DISABLED_MCP_KEY,
} from '../claude.const';

/** One project's entry in the CLI's home config, as far as this file cares. */
interface ProjectEntry {
  [CLAUDE_HOME_DISABLED_MCP_KEY]?: unknown;
  [CLAUDE_DISABLED_MCP_SERVERS_KEY]?: unknown;
}

/** The CLI's home config, as far as this file cares. */
export interface ClaudeHomeConfig {
  projects?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Read the CLI's home config, degrading to an EMPTY config when it is missing
 * or malformed rather than throwing.
 *
 * Deliberate on both paths: the reader renders a panel (an unreadable config
 * means "nothing is switched off", not an error), and the writer holds the
 * lock — treating a corrupt file as empty there would rewrite it wholesale and
 * destroy the user's state, so the WRITER checks the parse itself.
 */
export function parseHomeConfig(source: string): ClaudeHomeConfig {
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as ClaudeHomeConfig)
      : {};
  } catch {
    return {};
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function projectOf(config: ClaudeHomeConfig, cwd: string): ProjectEntry | null {
  const entry = config.projects?.[cwd];
  return typeof entry === 'object' && entry !== null
    ? (entry as ProjectEntry)
    : null;
}

/**
 * The servers this folder has switched OFF in the CLI's own config.
 *
 * The CLI's `/mcp` panel writes this list, and every turn honours it —
 * probe-verified on 2.1.222: a `local`-scope server named here reports
 * `status: 'disabled'` in the turn's init message instead of being dialled.
 * It is the ONE list that covers servers of every scope, which is why geniro's
 * own toggle writes it rather than keeping a private list the CLI cannot see.
 */
export function readDisabledServers(
  config: ClaudeHomeConfig,
  cwd: string,
): string[] {
  return stringList(projectOf(config, cwd)?.[CLAUDE_HOME_DISABLED_MCP_KEY]);
}

/**
 * Switch one server on or off for one folder, returning the config to write.
 *
 * PURE, and returns the SAME object when nothing changes, so the caller can
 * skip the write — a toggle to the state a server is already in must not
 * rewrite the user's config file.
 *
 * The project entry is CREATED when the folder has none: a folder claude has
 * never opened has no entry, and refusing to make one would mean a server can
 * only be switched off in folders the user has already used interactively.
 * Every other key of that entry is preserved untouched — this file rewrites
 * exactly one array.
 */
export function withDisabledServer(
  config: ClaudeHomeConfig,
  cwd: string,
  server: string,
  enabled: boolean,
): ClaudeHomeConfig {
  const current = readDisabledServers(config, cwd);
  const isDisabled = current.includes(server);
  if (isDisabled === !enabled) {
    return config;
  }
  const next = enabled
    ? current.filter((name) => name !== server)
    : [...current, server];
  const existing = projectOf(config, cwd) ?? {};
  return {
    ...config,
    projects: {
      ...config.projects,
      [cwd]: { ...existing, [CLAUDE_HOME_DISABLED_MCP_KEY]: next },
    },
  };
}
