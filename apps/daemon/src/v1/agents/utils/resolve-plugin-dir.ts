import { resolveValidDirectory } from './resolve-directory';

/**
 * Validate a node's plugin directory and return its canonical absolute path.
 *
 * This refusal is the ONLY thing that can tell a user their path is wrong.
 * Probe-verified on claude 2.1.220: `--plugin-dir` pointed at a missing
 * directory, at a directory holding no plugin, or at a plain file is SILENTLY
 * IGNORED — exit 0, no warning, "No MCP servers configured". So a typo would
 * otherwise present to the user as "this node has no MCP servers", which is
 * indistinguishable from the truth.
 *
 * A `.zip` is rejected along with every other non-directory. The CLI does
 * accept one, but the field is a plugin DIRECTORY and nothing in the app
 * offers a zip; widening this is a deliberate future decision, not something
 * to inherit by accident from a looser check.
 */
export function resolveValidPluginDir(pluginDir: string): string {
  return resolveValidDirectory(pluginDir, {
    errorCode: 'INVALID_PLUGIN_DIR',
    noun: 'pluginDir',
  });
}
