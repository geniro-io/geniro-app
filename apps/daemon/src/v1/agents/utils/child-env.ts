/**
 * Build a spawned child's environment from the daemon's, stripping every
 * `GENIRO_`-prefixed key. Those carry the daemon's own config and secrets — most
 * importantly the Cursor key, which the daemon receives as `GENIRO_CURSOR_API_KEY`
 * and the Cursor adapter re-injects as `CURSOR_API_KEY` via `extra` for its child
 * ONLY. Stripping them means no child (a headless agent CLI, any tool it spawns,
 * or a PTY terminal session) ever inherits another agent's credential or the
 * daemon's internal env. Shared by every daemon spawn path — extracted, never
 * mirrored.
 */
export function buildChildEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GENIRO_')) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}
