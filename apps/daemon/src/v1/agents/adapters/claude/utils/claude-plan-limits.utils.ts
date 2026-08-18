import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type { AgentPlanLimits, AgentPlanWindow } from '../../adapter.types';
import { CLAUDE_PLAN_LIMITS_SUBTYPE } from '../claude.const';

/**
 * Reading and writing the `get_usage` control dialogue — what the account
 * behind this chat is allowed, and how much of it is spent.
 *
 * Pure, like its `get_context_usage` and `mcp_status` siblings and for the same
 * reason: the session primitive that carries it (`CliSession.ask`) knows no
 * CLI's vocabulary, so everything about this one lives here and can be
 * exercised without a process. The probe evidence, the reply's shape and the
 * expiry warning are all at {@link CLAUDE_PLAN_LIMITS_SUBTYPE} in
 * `claude.const.ts`.
 */

/** The `get_usage` request line, newline-terminated for the dialogue. */
export function planLimitsRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: CLAUDE_PLAN_LIMITS_SUBTYPE },
  })}\n`;
}

/**
 * What to call each window kind the CLI reports.
 *
 * The CLI's own dialog labels these "Current session" and "Current week (all
 * models)"; the parenthetical is dropped because the scoped row beside it
 * already names its own model, so the qualifier only reads as a warning on the
 * one row that needs none.
 *
 * A kind that is NOT here is dropped by {@link readWindow} — never labelled
 * from its key. `weekly_scoped` reaches a human as a phrase nobody wrote for
 * them, and a mislabelled limit is worse than a missing one.
 */
const WINDOW_LABELS: Readonly<Record<string, string>> = {
  session: 'Current session',
  weekly_all: 'Current week',
};

/**
 * The label for a MODEL-SCOPED window, whose name comes out of the payload
 * rather than out of this map.
 *
 * That is the whole reason `limits[]` is read instead of the named
 * `five_hour`/`seven_day` map: the scoped row carries the display name the
 * server chose for the model bucket ("Fable"), which no table here could know
 * and which changes with the vendor's line-up rather than with this app.
 */
function scopedLabel(scope: unknown): string | null {
  const model = asRecord(asRecord(scope)?.model);
  const name = asString(model?.display_name);
  return name === null || name.trim() === '' ? null : `Current week · ${name}`;
}

/** One `limits[]` row projected, or null when it cannot be named or measured. */
function readWindow(row: unknown): AgentPlanWindow | null {
  const limit = asRecord(row);
  if (!limit) {
    return null;
  }
  const kind = asString(limit.kind);
  if (kind === null) {
    return null;
  }
  const label = WINDOW_LABELS[kind] ?? scopedLabel(limit.scope);
  if (label === null) {
    return null;
  }
  const percent = asNumber(limit.percent);
  // A window with no percentage is not a reading. Defaulting it to 0 would
  // render "0% used" — the single most reassuring thing the panel can say —
  // about a limit whose state is unknown.
  if (percent === null || !Number.isFinite(percent)) {
    return null;
  }
  return {
    key: kind,
    label,
    // Clamped, because the number drives a bar: the CLI reports 0-100 and a
    // stray 103 would draw past its track rather than full.
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: asString(limit.resets_at),
  };
}

/**
 * What one parsed stdout line says about the question `requestId` is waiting
 * on: the projected plan limits, or null for "not my reply, keep waiting".
 *
 * A REFUSAL reads as null too — same rule as the context reader, and the same
 * reason: one question, one answer, and a refusal and a timeout leave the
 * caller with the same empty readout.
 */
export function readPlanLimitsReply(
  obj: unknown,
  requestId: string,
): AgentPlanLimits | null {
  const line = asRecord(obj);
  if (!line || line.type !== 'control_response') {
    return null;
  }
  const envelope = asRecord(line.response);
  if (!envelope || envelope.request_id !== requestId) {
    return null;
  }
  if (envelope.subtype !== 'success') {
    return null;
  }
  const body = asRecord(envelope.response);
  if (!body) {
    return null;
  }
  const limits = asRecord(body.rate_limits);
  const windows = asArray(limits?.limits)
    .map(readWindow)
    .filter((window): window is AgentPlanWindow => window !== null);
  // No windows is not an answer. An account on an API key reports
  // `rate_limits_available: false` with nothing under it, and rendering that as
  // an empty limits section would say "no limits" about a reading that says
  // nothing at all — so it goes down the caller's "could not be read" path,
  // which has a sentence for it.
  if (windows.length === 0) {
    return null;
  }
  return { plan: asString(body.subscription_type), windows };
}
