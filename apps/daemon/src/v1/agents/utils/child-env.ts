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
 * own config), the daemon's runtime switch ({@link DAEMON_RUNTIME_ENV_KEYS}),
 * plus every name an adapter registered as isolated. The last
 * set is REGISTERED rather than written here because it is the union over
 * every CLI, and each CLI's names are facts about that CLI — they live in its
 * adapter, and `AgentAdapterRegistry` registers every adapter's as it is built
 * (`AgentAdapter.registerEnvIsolation`). That happens at DI time, before any
 * child is spawned, so no spawn can see a partial set.
 */
const isolatedKeys = new Set<string>();

/**
 * The switch the daemon itself runs under (`DaemonSupervisor` spawns it as
 * Electron with `ELECTRON_RUN_AS_NODE=1`). Inherited, it turns every Electron
 * app an agent launches — `pnpm dev`, `electron .`, VS Code's CLI — into a
 * bare Node, where `require('electron').app` is undefined. Only this name:
 * other `ELECTRON_*` keys (`ELECTRON_MIRROR`, `ELECTRON_SKIP_BINARY_DOWNLOAD`)
 * are the user's own and an agent's installs need them. The UI's twin has no
 * entry for it because Electron main never runs with it set.
 */
const DAEMON_RUNTIME_ENV_KEYS: ReadonlySet<string> = new Set([
  'ELECTRON_RUN_AS_NODE',
]);

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
 * `GENIRO_`-prefixed key, the daemon's own runtime switch
 * ({@link DAEMON_RUNTIME_ENV_KEYS}) and every registered isolated name, then
 * merging `extra` on top — which is how an adapter hands its OWN child a
 * credential or a setting the strip removed. Shared by every daemon spawn
 * path — extracted, never mirrored.
 */
export function buildChildEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !key.startsWith('GENIRO_') &&
      !DAEMON_RUNTIME_ENV_KEYS.has(key) &&
      !isolatedKeys.has(key)
    ) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}
