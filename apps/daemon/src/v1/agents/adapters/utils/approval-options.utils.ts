import type { ApprovalOption, ApprovalOptionScope } from '../adapter.types';

/**
 * The words on a remembering option's button, by what it does and how long it
 * lasts — one wording for every CLI, so the same reach reads the same on any
 * agent's card.
 *
 * Built from the option's REAL scope rather than copied from the CLI's own
 * label: cursor calls an answer "Allow always" that geniro's per-conversation
 * profile turns into a session-long one, and a button promising more than the
 * CLI will keep is worse than no button.
 */
export function approvalOptionLabel(
  allow: boolean,
  scope: ApprovalOptionScope,
): string {
  if (scope === 'session') {
    return allow ? 'Allow for this session' : 'Deny for this session';
  }
  return allow ? 'Always allow' : 'Always deny';
}

/** One remembering option, labelled by {@link approvalOptionLabel}. */
export function approvalOption(
  id: string,
  allow: boolean,
  scope: ApprovalOptionScope,
  reply?: unknown,
): ApprovalOption {
  return {
    id,
    label: approvalOptionLabel(allow, scope),
    allow,
    scope,
    ...(reply === undefined ? {} : { reply }),
  };
}
