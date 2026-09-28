import type { CliKind } from '../shared/contracts';
import { AGENT_DESCRIPTORS, descriptorFor } from './agents/agent-descriptors';

/**
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/child-env.ts`.
 *
 * The daemon strips every CLI's isolated env names from each child it spawns
 * and re-injects only what that child is entitled to, so no spawned agent
 * inherits another agent's credential. The Electron main process spawns CLI
 * children too — `detectClis` runs `--version` and a login `status` on every
 * binary — so it applies the same rule here, composed from each CLI's own
 * descriptor (`agents/`), since the two apps share no code.
 *
 * **The two sides are NOT mirror images.** The daemon withholds a CLI's own
 * profile and session identity even from that CLI's children, because there a
 * chat's profile is part of the run's identity. A probe has no run identity to
 * protect — it asks one binary about itself — so here a CLI keeps everything
 * it owns and is denied only what the OTHER CLIs own.
 */

/** Every env name any CLI owns, whoever owns it. */
export const ALL_AGENT_ENV_KEYS: readonly string[] = Object.values(
  AGENT_DESCRIPTORS,
).flatMap((descriptor) => descriptor.ownEnvKeys);

/**
 * The environment for a one-shot probe of ONE CLI binary: the process env minus
 * every other agent's credentials. A login-state probe is an authenticated call
 * to the vendor's API, so it must not be holding a rival agent's token.
 */
export function probeEnv(kind: CliKind): NodeJS.ProcessEnv {
  const own = descriptorFor(kind).ownEnvKeys;
  return withoutKeys(ALL_AGENT_ENV_KEYS.filter((key) => !own.includes(key)));
}

/**
 * The environment for a child that is entitled to NONE of these credentials —
 * a third-party binary that is not one of the agents at all. `gh` is the case
 * it was written for: it makes an authenticated call to GitHub, so it must not
 * hold any agent's token, and it owns nothing on the list to keep.
 */
export function neutralEnv(): NodeJS.ProcessEnv {
  return withoutKeys(ALL_AGENT_ENV_KEYS);
}

function withoutKeys(withheld: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!withheld.includes(key)) {
      env[key] = value;
    }
  }
  return env;
}
