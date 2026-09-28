import type { AgentKind } from '../../runs/runs.types';
import { asRecord } from './json-util';

/**
 * TWIN PARSER: `apps/ui/src/main/daemon-supervisor.ts` (`cliPathsEnv`).
 *
 * The user's Settings "cliPaths" overrides, as ONE JSON object keyed by agent
 * kind (`{"claude":"/opt/tools/claude"}`) on the daemon spawn env. One variable
 * rather than one per CLI, so neither side of the spawn names an agent: the UI
 * serializes whatever map the user saved, and this reads the entry for the kind
 * it is asked about. `GENIRO_`-prefixed, so {@link buildChildEnv} strips it from
 * every spawned child — the override is resolved HERE and travels as the spawn
 * command, never as child env.
 */
export const CLI_PATHS_ENV = 'GENIRO_CLI_PATHS';

/**
 * The binary to spawn for an agent kind: the override path, else the bare name
 * the kind is spelled with (every shipped CLI's binary IS its kind).
 *
 * Read per call rather than once, so a test stubbing the env and a daemon whose
 * env is rewritten both see the value that is actually set. A malformed value
 * reads as "no override" — the bare name then resolves through PATH, which is
 * what an unset override does anyway.
 */
export function resolveAgentBinary(kind: AgentKind): string {
  const override = cliPathOverrides()[kind]?.trim();
  return override ? override : kind;
}

function cliPathOverrides(): Record<string, string | undefined> {
  const raw = process.env[CLI_PATHS_ENV]?.trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const record = asRecord(parsed);
  if (record === null) {
    return {};
  }
  const paths: Record<string, string> = {};
  for (const [kind, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      paths[kind] = value;
    }
  }
  return paths;
}
