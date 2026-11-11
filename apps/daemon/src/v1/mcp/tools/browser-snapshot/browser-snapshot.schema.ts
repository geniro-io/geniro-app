import { toolInputSchema } from '../tool-args';
import { BrowserSnapshotArgsSchema } from './browser-snapshot.reader';

/** `browser_snapshot`'s arguments — generated from the schema they are parsed with. */
export function browserSnapshotSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserSnapshotArgsSchema);
}
