import { toolInputSchema } from '../tool-args';
import { BrowserEvaluateArgsSchema } from './browser-evaluate.reader';

/** `browser_evaluate`'s arguments — generated from the schema they are parsed with. */
export function browserEvaluateSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserEvaluateArgsSchema);
}
