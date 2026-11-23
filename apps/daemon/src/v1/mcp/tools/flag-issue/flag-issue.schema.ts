import { toolInputSchema } from '../tool-args';
import { FlagIssueArgsSchema } from './flag-issue.reader';

/** `flag_issue`'s arguments. */
export function flagIssueSchema(): Record<string, unknown> {
  return toolInputSchema(FlagIssueArgsSchema);
}
