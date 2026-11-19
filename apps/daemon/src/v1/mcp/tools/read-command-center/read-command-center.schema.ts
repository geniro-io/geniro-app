import { ReadCommandCenterSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `read_command_center`'s arguments — generated from the schema they are parsed with. */
export function readCommandCenterSchema(): Record<string, unknown> {
  return toolInputSchema(ReadCommandCenterSchema);
}
