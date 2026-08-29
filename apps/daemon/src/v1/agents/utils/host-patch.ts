import {
  HOST_PATCH_TOOL,
  type HostPatch,
  type HostPatchOutcome,
  MAX_PATCH_PATH_LENGTH,
  MAX_PATCH_SUMMARY_LENGTH,
  MAX_PATCH_TEXT_LENGTH,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN patch tool.
 *
 * Auto-approved like its two siblings, which reads wrong at first: this is the
 * one host tool that writes to the user's disk, so surely the permission card
 * belongs in front of it? No — that card would guard the wrong door. Calling
 * this tool WRITES NOTHING; it puts a diff on screen with Apply and Reject, and
 * the write is behind that second press. Refusing to auto-approve the call
 * therefore buys no safety and costs the user a meaningless card in front of
 * the meaningful one — observed on a live turn, where answering the first
 * decided nothing at all.
 */
export function isHostPatchCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PATCH_TOOL);
}

/**
 * A read patch, or the sentence saying why it could not be read.
 *
 * A reason rather than a bare null, because every failure here is something the
 * agent can FIX and retry — a path it forgot, a body over the cap, a no-op
 * edit — and "INVALID_ARGS" with nothing after it makes it guess which.
 */
export type PatchRead =
  { ok: true; patch: HostPatch } | { ok: false; reason: string };

/**
 * Read a `propose_patch` call's arguments.
 *
 * Defensive like every host-tool reader, with ONE rule inverted: the size caps
 * REFUSE instead of truncating. Everywhere else truncation is the kind failure
 * — a model that found forty things has still done the work — but the first
 * `MAX_PATCH_TEXT_LENGTH` characters of a file body is a TRUNCATED FILE, and
 * writing one because the model was verbose is the worst outcome this tool has.
 *
 * The one field that still truncates is `summary`, which is a caption.
 */
export function readHostPatch(args: Record<string, unknown>): PatchRead {
  const filePath =
    typeof args.file_path === 'string' ? args.file_path.trim() : '';
  if (filePath.length === 0) {
    return { ok: false, reason: "'file_path' must be a non-empty string." };
  }
  if (filePath.length > MAX_PATCH_PATH_LENGTH) {
    return {
      ok: false,
      reason: `'file_path' is longer than ${MAX_PATCH_PATH_LENGTH} characters.`,
    };
  }
  const newString = args.new_string;
  // Tested for TYPE, not truthiness: the empty string is a legitimate patch —
  // it is how a block is deleted — and `!newString` would refuse exactly that.
  if (typeof newString !== 'string') {
    return {
      ok: false,
      reason:
        '\'new_string\' must be a string (use "" to delete the matched text).',
    };
  }
  if (newString.length > MAX_PATCH_TEXT_LENGTH) {
    return {
      ok: false,
      reason: `'new_string' is longer than ${MAX_PATCH_TEXT_LENGTH} characters. Propose the change in smaller pieces — this tool will not write a truncated file.`,
    };
  }
  const rawOld = args.old_string;
  let oldString: string | undefined;
  if (rawOld !== undefined && rawOld !== null) {
    if (typeof rawOld !== 'string') {
      return {
        ok: false,
        reason:
          "'old_string' must be a string when given, or omitted to write the whole file.",
      };
    }
    // An empty search matches at every position, so it names no edit at all.
    // Omitting the field is how a whole-file write is asked for.
    if (rawOld.length === 0) {
      return {
        ok: false,
        reason:
          "'old_string' cannot be empty — omit it to write the whole file.",
      };
    }
    if (rawOld.length > MAX_PATCH_TEXT_LENGTH) {
      return {
        ok: false,
        reason: `'old_string' is longer than ${MAX_PATCH_TEXT_LENGTH} characters.`,
      };
    }
    if (rawOld === newString) {
      return {
        ok: false,
        reason:
          "'old_string' and 'new_string' are identical — that patch changes nothing.",
      };
    }
    oldString = rawOld;
  }
  const summary =
    typeof args.summary === 'string' && args.summary.trim().length > 0
      ? args.summary.trim().slice(0, MAX_PATCH_SUMMARY_LENGTH)
      : undefined;
  return {
    ok: true,
    patch: {
      filePath,
      newString,
      ...(oldString === undefined ? {} : { oldString }),
      ...(summary === undefined ? {} : { summary }),
    },
  };
}

/**
 * The tool result text for one outcome.
 *
 * A receipt like its siblings', but this one carries a DECISION the agent has
 * to act on, so each arm says what happened and, where there is one, what the
 * next move is. `stale` in particular must not read as a refusal: the user said
 * yes, and the right response is to re-read the file rather than to argue.
 */
export function hostPatchResultText(outcome: HostPatchOutcome): string {
  switch (outcome.status) {
    case 'applied':
      return `Applied to ${outcome.path}. The file on disk now has your change; do not write it again.`;
    case 'declined':
      return 'The user rejected the patch. Do not apply it another way — ask what they would prefer.';
    case 'stale':
      return `The user accepted the patch but it could not be applied (${outcome.reason}). Re-read the file and propose again against its current text.`;
    case 'unavailable':
      return `The patch could not be put to the user (${outcome.reason}). Describe the change in your reply instead.`;
  }
}
