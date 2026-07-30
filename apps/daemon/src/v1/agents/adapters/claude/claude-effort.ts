import type { AgentEffort } from '../adapter.types';

/**
 * The values `claude --effort` accepts, weakest first.
 *
 * WRITTEN DOWN RATHER THAN SCRAPED, because the CLI under-reports itself. Its
 * own `--help` says "Valid values: low, medium, high, xhigh, max" and its
 * warning line repeats that set — but `ultracode` is accepted just as
 * silently as the five it names.
 *
 * Probe-verified on claude 2.1.220 (2026-07-29) by feeding each candidate and
 * testing for the `Unknown --effort value` warning:
 * - accepted, no warning: low, medium, high, xhigh, max, `ultracode`
 * - rejected with the warning: `ultrathink`, and the control `zzz-not-a-level`
 *
 * So a `--help` scrape would drop `ultracode` (a level the user asked for by
 * name), and guessing would never have found it. Re-probe the same way when
 * this list is revised; do not copy it out of help output.
 */
export const CLAUDE_EFFORT_LEVELS: readonly AgentEffort[] = [
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
  { id: 'ultracode', label: 'ultracode' },
];
