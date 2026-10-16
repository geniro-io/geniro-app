import { asArray, asRecord, asString } from '../../../utils/json-util';
import {
  CLAUDE_INITIALIZE_SUBTYPE,
  CLAUDE_MODEL_RESOLUTION_REQUEST_ID,
} from '../claude.const';

/**
 * Reading the `initialize` control reply for what each model name resolves
 * to — the probe evidence is at {@link CLAUDE_INITIALIZE_SUBTYPE}'s block in
 * `claude.const.ts`.
 */

/** Model name (`haiku`, `default`, an id) → the id it runs as. */
export type ClaudeModelResolutions = Readonly<Record<string, string>>;

/** The `initialize` request line, newline-terminated for stdin. */
export function modelResolutionRequestLine(): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: CLAUDE_MODEL_RESOLUTION_REQUEST_ID,
    request: { subtype: CLAUDE_INITIALIZE_SUBTYPE },
  })}\n`;
}

/**
 * The resolutions in the probe's stdout, or null while its reply has not
 * arrived (or never named a model). A row without a `resolvedModel` resolves
 * to nothing rather than to itself: the reply names one for every model this
 * CLI can run.
 */
export function readModelResolutions(
  stdout: string,
): ClaudeModelResolutions | null {
  for (const raw of stdout.split('\n')) {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const envelope = asRecord(asRecord(line)?.response);
    if (
      asRecord(line)?.type !== 'control_response' ||
      envelope?.request_id !== CLAUDE_MODEL_RESOLUTION_REQUEST_ID ||
      envelope.subtype !== 'success'
    ) {
      continue;
    }
    const resolutions: Record<string, string> = {};
    for (const entry of asArray(asRecord(envelope.response)?.models)) {
      const value = asString(asRecord(entry)?.value);
      const resolved = asString(asRecord(entry)?.resolvedModel);
      if (value && resolved) {
        resolutions[value] = resolved;
      }
    }
    return Object.keys(resolutions).length > 0 ? resolutions : null;
  }
  return null;
}

/** Whether a stored value is a resolution map — the store re-validates on read. */
export function isModelResolutions(
  value: unknown,
): value is ClaudeModelResolutions {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (resolved) => typeof resolved === 'string' && resolved !== '',
    )
  );
}
