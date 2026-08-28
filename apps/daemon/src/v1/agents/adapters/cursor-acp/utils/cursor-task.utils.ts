import { asNumber, asRecord, asString } from '../../../utils/json-util';
import type { AcpDelegateFacts } from '../../acp/acp-driver';
import { CURSOR_SUBAGENT_TYPE_UNSPECIFIED } from '../cursor-acp.const';

/**
 * Reading `cursor/task`, cursor's vendor extension announcing one background
 * sub-agent it ran.
 *
 * See the `Background sub-agents` block in `cursor-acp.const.ts` for the frames
 * this was measured against and what each field was observed to hold. Defensive
 * throughout, on the same rule as the question parser beside it: returning null
 * is what makes the driver decline the request rather than write a transcript row
 * from a payload it could not read.
 */

/**
 * The delegate one `cursor/task` request describes, or null when the params
 * carry no tool call id to anchor it to.
 *
 * The id is the ONLY required field. Everything else is genuinely optional on
 * this channel — a delegation that failed reports no `durationMs`, and a plain
 * one names no type — and a row saying "a sub-agent ran and we know nothing
 * else" is still the truth, where refusing the whole announcement over a missing
 * description would discard the brief that IS there.
 */
export function readCursorTask(params: unknown): AcpDelegateFacts | null {
  const root = asRecord(params);
  const id = root ? asString(root.toolCallId) : null;
  if (id === null || id === '') {
    return null;
  }
  return {
    id,
    label: nonEmpty(asString(root?.description)),
    kind: readSubagentType(root?.subagentType),
    prompt: nonEmpty(asString(root?.prompt)),
    model: nonEmpty(asString(root?.model)),
    // `agentId` is deliberately dropped: it is the delegate's own conversation
    // id inside the CLI's private store, which nothing here can open, so
    // carrying it would put an identifier on the wire that no reader can use.
    durationMs: asNumber(root?.durationMs),
  };
}

/**
 * Whether the `task` call's own return says the delegate keeps running after
 * it — cursor's `isBackground`, read off that call's `rawOutput`.
 *
 * The launch and the completion are the SAME frame shape on this wire, so this
 * boolean is the only thing separating them. MEASURED on 2026.08.11-e8db854 by
 * asking for a background delegate: `rawOutput: {durationMs: 203,
 * isBackground: true}`, the turn ending four seconds later, and the delegate
 * still asking this client for shell permissions seventy seconds after that.
 * The neighbouring `cursor/task` announcement does NOT carry the field (the
 * CLI's own `sendToolExtensionNotification` builds it from the args and the
 * duration), which is why this reads the tool call's output instead.
 *
 * Null rather than false for a missing or unreadable field: a CLI that stopped
 * sending it must leave the old reading alone, not assert that every delegate
 * waits.
 */
export function readCursorLaunchIsBackground(
  rawOutput: unknown,
): boolean | null {
  const value = asRecord(rawOutput)?.isBackground;
  return typeof value === 'boolean' ? value : null;
}

/**
 * What the delegate was asked to BE, as a name, or null when it was not typed.
 *
 * Two shapes, both from the CLI's own `mapSubagentType`: a bare string for a
 * type it knows (`explore`, `computer_use`, …), and `{custom: <value>}` for
 * anything else — where the value is itself a protobuf oneof rendered as an
 * object, so the NAME is its single key. Measured: an untyped delegation arrives
 * as `{custom:{unspecified:{}}}`, which is why the placeholder names are
 * filtered out at the end rather than at one of the two shapes.
 */
function readSubagentType(value: unknown): string | null {
  const direct = asString(value);
  if (direct !== null) {
    return meaningfulType(direct);
  }
  const record = asRecord(value);
  const custom = record ? record.custom : undefined;
  if (custom === undefined) {
    return null;
  }
  const customName = asString(custom);
  if (customName !== null) {
    return meaningfulType(customName);
  }
  const nested = asRecord(custom);
  const [key] = nested === null ? [] : Object.keys(nested);
  return key === undefined ? null : meaningfulType(key);
}

/** A type name, or null when it is one of the CLI's "no type given" spellings. */
function meaningfulType(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === '' ||
    CURSOR_SUBAGENT_TYPE_UNSPECIFIED.includes(trimmed.toLowerCase())
    ? null
    : trimmed;
}

/** Empty strings are absent fields, not values — the CLI sends `""` for both. */
function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}
