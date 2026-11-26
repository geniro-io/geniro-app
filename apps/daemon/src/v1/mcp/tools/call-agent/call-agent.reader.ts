import {
  applyArgSynonyms,
  type ArgSynonyms,
  leadWithCall,
} from '../../../../utils/tool-arg-synonyms';
import {
  CALL_MODES,
  type CallEnvelope,
  type CallMode,
} from '../../../teams/teams.types';
import { invalidArgsEnvelope, unknownArgsEnvelope } from '../call-mcp-tool';

/**
 * The bound on `call_agent`'s `title` — a one-sentence reason shown on the
 * call's transcript card, not a brief. Long enough for a real sentence,
 * short enough that a caller writing a brief there instead is refused rather
 * than quietly truncated onto the card.
 */
export const MAX_CALL_TITLE_LENGTH = 200;

/**
 * The title is the call card's headline and its accessible name, so a
 * direction override or an invisible control character could make it read as
 * something other than what the agent sent.
 */
const UNREADABLE_TITLE_CHARACTERS = /[\p{Cc}\p{Bidi_Control}]/u;

/**
 * Every argument each call tool reads — anything else is REFUSED, never
 * ignored. An ignored argument is what turned a model's `timeout_seconds:
 * "180"` into a wait with no window at all: the model believed it had bounded
 * the wait, the daemon saw no `timeout_ms`, and the caller's HTTP client cut
 * the request after five minutes, for an hour (run `51c646fb`). A refusal
 * naming these is answered at once and corrects the next call, which is what
 * happened the one time the same model's guess was a MISSING argument rather
 * than a misnamed one (`agent_id` → `'agent' must be a non-empty string`).
 */
const CALL_AGENT_ARGS = [
  'agent',
  'message',
  'title',
  'thread',
  'mode',
  'member',
  'resume_cold',
  'folder',
];

export const CALL_AGENT_SYNONYMS: ArgSynonyms = { agent_id: 'agent' };

const CALL_AGENT_CALL =
  'call call_agent({agent: "<member id>", message: "<the task>", title: "<why you call it>", mode: "async"}).';

/** `async` and `sync` as a first call writes them, each read as the `mode` it means. */
const MODE_FLAGS: Readonly<Record<string, { yes: CallMode; no: CallMode }>> = {
  async: { yes: 'async', no: 'sync' },
  sync: { yes: 'sync', no: 'async' },
};

export interface CheckedCallAgentArgs {
  /** The TRIMMED title the call goes out with, so the value checked is the value sent. */
  title: string;
  /** The arguments with every synonym read as the name the tool reads. */
  args: Record<string, unknown>;
}

/**
 * Arg validation happens in-envelope — never throw across the transport.
 * Answers the refusal, opening with the right call, or the arguments the call
 * goes out with.
 */
export function validateCallAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | CheckedCallAgentArgs {
  const read = readModeFlags(args);
  const checked = read.ok ? checkCallAgentArgs(read.args) : read.error;
  if (typeof checked === 'string' && read.ok) {
    return { title: checked, args: read.args };
  }
  const reason =
    typeof checked === 'string'
      ? checked
      : checked.status === 'error'
        ? checked.error.replace(/^INVALID_ARGS: /, '')
        : '';
  return invalidArgsEnvelope(leadWithCall(CALL_AGENT_CALL, reason));
}

function readModeFlags(
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const renamed = applyArgSynonyms(args, CALL_AGENT_SYNONYMS);
  if (!renamed.ok) {
    return renamed;
  }
  const { async: asAsync, sync: asSync, ...rest } = renamed.args;
  const modes = new Set<unknown>(rest.mode === undefined ? [] : [rest.mode]);
  for (const [flag, value] of Object.entries({
    async: asAsync,
    sync: asSync,
  })) {
    if (value === undefined || value === null) {
      continue;
    }
    const yes = value === true || value === 'true';
    if (!yes && value !== false && value !== 'false') {
      return { ok: false, error: `'${flag}' must be true or false` };
    }
    modes.add(yes ? MODE_FLAGS[flag]!.yes : MODE_FLAGS[flag]!.no);
  }
  if (modes.size > 1) {
    return {
      ok: false,
      error: "'mode', 'async' and 'sync' disagree — send 'mode' alone",
    };
  }
  const [mode] = modes;
  return { ok: true, args: mode === undefined ? rest : { ...rest, mode } };
}

function checkCallAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | string {
  const unknown = unknownArgsEnvelope(args, CALL_AGENT_ARGS);
  if (unknown) {
    return unknown;
  }
  if (typeof args.agent !== 'string' || args.agent.trim().length === 0) {
    return invalidArgsEnvelope("'agent' must be a non-empty string");
  }
  if (typeof args.message !== 'string' || args.message.length === 0) {
    return invalidArgsEnvelope("'message' must be a non-empty string");
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title.length === 0) {
    return invalidArgsEnvelope("'title' must be a non-empty string");
  }
  if (UNREADABLE_TITLE_CHARACTERS.test(title)) {
    return invalidArgsEnvelope(
      "'title' must not contain control or text-direction characters",
    );
  }
  if (title.length > MAX_CALL_TITLE_LENGTH) {
    return invalidArgsEnvelope(
      `'title' exceeds ${MAX_CALL_TITLE_LENGTH} characters — summarize it`,
    );
  }
  if (args.mode !== undefined && !CALL_MODES.includes(args.mode as CallMode)) {
    return invalidArgsEnvelope(
      "'mode' must be sync, async, or fire_and_forget",
    );
  }
  if (
    args.thread !== undefined &&
    (typeof args.thread !== 'string' || args.thread.length === 0)
  ) {
    return invalidArgsEnvelope("'thread' must be a non-empty call_id string");
  }
  if (
    args.folder !== undefined &&
    (typeof args.folder !== 'string' || args.folder.trim().length === 0)
  ) {
    return invalidArgsEnvelope(
      "'folder' must be a non-empty path to a subfolder of this chat's folder",
    );
  }
  if (args.member !== undefined && poolMemberArg(args.member) === null) {
    return invalidArgsEnvelope(
      "'member' must be a pool member number (1, 2, …)",
    );
  }
  if (args.resume_cold !== undefined) {
    if (typeof args.resume_cold !== 'boolean') {
      return invalidArgsEnvelope("'resume_cold' must be true or false");
    }
    if (args.resume_cold && args.thread === undefined) {
      return invalidArgsEnvelope(
        "'resume_cold' only applies with 'thread' — a new conversation has no cache to lose",
      );
    }
  }
  return title;
}

/**
 * `call_agent`'s `member`, read leniently in one direction only: a model that
 * writes `"2"` means member 2, while anything that is not a whole number from
 * 1 up names no member and is refused.
 */
export function poolMemberArg(value: unknown): number | null {
  const member =
    typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return typeof member === 'number' && Number.isInteger(member) && member >= 1
    ? member
    : null;
}
