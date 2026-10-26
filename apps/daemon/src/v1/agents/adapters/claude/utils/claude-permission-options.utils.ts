import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { ApprovalOption } from '../../adapter.types';
import { approvalOption } from '../../utils/approval-options.utils';
import {
  CLAUDE_APPROVAL_OPTION_IDS,
  CLAUDE_REMEMBERED_SUGGESTION_TYPES,
  CLAUDE_SESSION_PERMISSION_DESTINATION,
} from '../claude.const';

/**
 * The card's remembering options for one `can_use_tool` request, built from
 * the `permission_suggestions` it carried — see the "Remembered approvals"
 * block in `claude.const.ts` for what each one was measured to do.
 *
 * - "this session": the kept suggestions with every `destination` rewritten to
 *   `session`, so nothing reaches a settings file.
 * - "always": the kept suggestions as claude gave them, offered only when one
 *   of them names a settings file — otherwise it would be the session option
 *   under a second name.
 *
 * Each option's `reply` is the `updatedPermissions` list its allow carries.
 * Empty when the request suggested nothing this client echoes.
 */
export function claudePermissionOptions(
  suggestions: unknown,
): ApprovalOption[] {
  const kept = asArray(suggestions).flatMap((entry) => {
    const record = asRecord(entry);
    const type = record ? asString(record.type) : null;
    return record &&
      type !== null &&
      CLAUDE_REMEMBERED_SUGGESTION_TYPES.has(type)
      ? [record]
      : [];
  });
  if (kept.length === 0) {
    return [];
  }
  const options = [
    approvalOption(
      CLAUDE_APPROVAL_OPTION_IDS.session,
      true,
      'session',
      kept.map((suggestion) => ({
        ...suggestion,
        destination: CLAUDE_SESSION_PERMISSION_DESTINATION,
      })),
    ),
  ];
  const persists = kept.some(
    (suggestion) =>
      asString(suggestion.destination) !==
      CLAUDE_SESSION_PERMISSION_DESTINATION,
  );
  if (persists) {
    options.push(
      approvalOption(CLAUDE_APPROVAL_OPTION_IDS.always, true, 'always', kept),
    );
  }
  return options;
}

/**
 * The `updatedPermissions` an allow carries for a picked option, or null for a
 * one-time answer. Read off the option's own `reply` — the list
 * {@link claudePermissionOptions} built from the request — since the reply
 * frame cannot see the request again.
 */
export function claudeUpdatedPermissions(
  option: ApprovalOption | undefined,
): unknown[] | null {
  const reply = option?.reply;
  return Array.isArray(reply) && reply.length > 0 ? reply : null;
}
