import { toolInputSchema } from '../tool-args';
import { SavePluginArgsSchema } from './save-plugin.reader';

/** `save_plugin`'s arguments — generated from the schema they are parsed with. */
export function savePluginSchema(): Record<string, unknown> {
  return toolInputSchema(SavePluginArgsSchema);
}
