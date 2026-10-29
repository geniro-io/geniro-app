import { asArray, asRecord, asString } from '../../../utils/json-util';
import {
  CODEX_HOOKS_STATE_KEY,
  CODEX_PERMISSION_REQUEST_HOOK_EVENT,
} from '../codex.const';

/**
 * The thread config that switches off every enabled permission-request hook a
 * `hooks/list` result names, or `{}` when there is none. A managed hook (an
 * administrator's, `isManaged`) is left on: it is a policy, not the user's.
 *
 * `hooks.state` carries a table because a hook's key holds dots (it starts
 * with its file's path), so it cannot be written as one dotted key.
 */
export function codexPermissionHookOverrides(
  hooksResult: unknown,
): Record<string, unknown> {
  const off: Record<string, { enabled: false }> = {};
  for (const entry of asArray(asRecord(hooksResult)?.data)) {
    for (const hook of asArray(asRecord(entry)?.hooks)) {
      const record = asRecord(hook);
      const key = asString(record?.key);
      if (
        key !== null &&
        record?.eventName === CODEX_PERMISSION_REQUEST_HOOK_EVENT &&
        record.enabled === true &&
        record.isManaged !== true
      ) {
        off[key] = { enabled: false };
      }
    }
  }
  return Object.keys(off).length > 0 ? { [CODEX_HOOKS_STATE_KEY]: off } : {};
}
