/**
 * TWIN PARSER: `apps/ui/src/main/probe-env.ts`.
 *
 * The Electron main process spawns CLI children of its own (`detectClis` runs
 * `--version` and a login `status` on every binary) and shares no code with this
 * app, so it carries its own copy of the same rule, composed from its own
 * per-agent descriptors. A name added to an adapter's
 * `AdapterConfig.auth.isolatedEnvKeys` belongs in that CLI's descriptor there
 * too, and the reverse — nothing type-checks across the boundary.
 *
 * What a child must never inherit: every `GENIRO_`-prefixed key (the daemon's
 * own config), plus every name an adapter registered as isolated. The second
 * set is REGISTERED rather than written here because it is the union over
 * every CLI, and each CLI's names are facts about that CLI — they live in its
 * adapter, and `AgentAdapterRegistry` registers every adapter's as it is built
 * (`AgentAdapter.registerEnvIsolation`). That happens at DI time, before any
 * child is spawned, so no spawn can see a partial set.
 */
const isolatedKeys = new Set<string>();

/**
 * Add names to the set {@link buildChildEnv} strips from every child.
 * Idempotent and append-only: the env it guards is process-wide, and nothing
 * that registered a name is around to unregister it.
 */
export function registerIsolatedEnvKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    isolatedKeys.add(key);
  }
}

/**
 * Build a spawned child's environment from the daemon's, stripping every
 * `GENIRO_`-prefixed key plus every registered isolated name, then merging
 * `extra` on top — which is how an adapter hands its OWN child a credential or
 * a setting the strip removed. Shared by every daemon spawn path — extracted,
 * never mirrored.
 */
export function buildChildEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GENIRO_') && !isolatedKeys.has(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}
