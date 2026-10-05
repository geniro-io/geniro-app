import type { AcpEndedDelegate } from '../../acp/acp-driver';

/**
 * The prompt that tells a cursor parent its background sub-agents have ended —
 * the stand-in for the wakeup its own interactive client would have run and its
 * ACP server never does. See the `Background sub-agents` block in
 * `cursor-acp.const.ts`.
 *
 * Each delegate's REPORT is carried in it, because nothing else will carry it:
 * over ACP the `task` call either returned the moment the delegate was
 * launched, or was cut off with the request it ran under while the delegate
 * worked on — either way the parent holds no result for it. A report that is
 * long is cut, and the transcript it came from is always named, so the agent
 * can read the rest.
 */
export function cursorDelegateWakePrompt(
  ended: readonly AcpEndedDelegate[],
): string {
  return [
    ended.length === 1
      ? 'Your background sub-agent has finished.'
      : `Your ${ended.length} background sub-agents have finished.`,
    'This message is how you learn it: their results do not reach you on their own — the `task` call that launched each one either returned before it did any work, or was cut off by an interruption while it ran on. Their reports are below.',
    '',
    ...cursorDelegateReports(ended),
    'Carry on with the task you were working on, using these results, and finish it in this turn.',
  ].join('\n');
}

/**
 * One section per delegate — its name, how it ended, where its transcript is
 * and what it reported — bounded per report and across all of them, so a
 * fan-out of ten stays a prompt rather than a dump. Every delegate is still
 * NAMED past the budget: an agent told nothing about one assumes it never ran.
 */
export function cursorDelegateReports(
  ended: readonly AcpEndedDelegate[],
): string[] {
  const lines: string[] = [];
  let budget = TOTAL_REPORT_CHARS;
  ended.forEach((delegate, index) => {
    const name = delegate.label ?? `Sub-agent ${index + 1}`;
    lines.push(
      `## ${name} — ${OUTCOME_WORDS[delegate.outcome ?? 'unknown']}${durationText(delegate.durationMs)}`,
    );
    if (delegate.recordPath !== null) {
      lines.push(`Transcript: ${delegate.recordPath}`);
    }
    const report = delegate.finalText?.trim() ?? '';
    if (report === '') {
      lines.push('(It left no final report.)');
    } else {
      const room = Math.max(0, Math.min(REPORT_CHARS, budget));
      budget -= Math.min(report.length, room);
      lines.push(
        report.length <= room
          ? report
          : `${report.slice(0, room)}\n[… cut here — the rest is in the transcript above]`,
      );
    }
    lines.push('');
  });
  return lines;
}

/** How much of one report the prompt carries. */
const REPORT_CHARS = 20_000;

/** How much of ALL the reports together — a fan-out of ten stays bounded. */
const TOTAL_REPORT_CHARS = 80_000;

const OUTCOME_WORDS: Record<string, string> = {
  completed: 'finished',
  failed: 'failed',
  stopped: 'was stopped',
  unknown: 'ended (its transcript could not be read, so how is not known)',
};

function durationText(ms: number | null): string {
  if (ms === null || ms < 0) {
    return '';
  }
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0
    ? ` after ${seconds}s`
    : ` after ${minutes}m ${seconds % 60}s`;
}
