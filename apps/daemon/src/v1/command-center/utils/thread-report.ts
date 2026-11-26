import { redactSecrets } from '../../diagnostics/utils/redact';

export const THREAD_REPORT_MAX_CHARS = 2000;

/**
 * What a finished thread reported: the outcome its agent recorded, else the
 * newest message its agent wrote — never the user's own words.
 */
export function threadReportOf(
  outcomeSummary: string | null | undefined,
  agentMessage: string | null,
): string | null {
  const recorded = outcomeSummary?.trim() ?? '';
  const text = redactSecrets(
    recorded === '' ? (agentMessage?.trim() ?? '') : recorded,
  );
  if (text === '') {
    return null;
  }
  return text.length > THREAD_REPORT_MAX_CHARS
    ? `${text.slice(0, THREAD_REPORT_MAX_CHARS - 1)}…`
    : text;
}
