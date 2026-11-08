import { z } from 'zod';

import {
  MONITOR_COMMAND_MAX,
  MONITOR_DESCRIPTION_MAX,
  MONITOR_TIMEOUT_DEFAULT_MS,
  MONITOR_TIMEOUT_MAX_MS,
  MONITOR_TIMEOUT_MIN_MS,
  type MonitorStartInput,
  type MonitorStartOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

// A C0 control character (NUL included, which makes `spawn` throw) has no place
// in a command line or a label.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const FOLLOWING_TAIL =
  /(?:^|[\s(])tail\s(?:.*\s)?(?:-[a-zA-Z0-9+]*[fF][a-zA-Z0-9]*|--follow(?:=\S*)?)(?:\s|$)/;
const GREP_THAT_STOPS =
  /^\s*\(?\s*(?:[ef]?grep|rg)\s(?:.*\s)?(?:-[a-zA-Z]*[mq][a-zA-Z0-9]*|--max-count\S*|--quiet|--silent)(?:\s|$)/;
const HEAD = /^\s*\(?\s*head(?:\s|$)/;
const SED = /^\s*\(?\s*g?sed\s/;
const SED_QUIT = /[/;{'"\s\d]q\d*\s*(?:[;}'"]|$)/;
const AWK = /^\s*\(?\s*g?awk\s/;
const AWK_EXIT = /\bexit\b/;

/** The line with every quoted character blanked, its length kept. */
function blankQuotes(line: string): string {
  let quote: string | null = null;
  let blanked = '';
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    if (char === '\\' && quote !== "'") {
      blanked += line.slice(at, at + 2).replace(/[^]/g, '_');
      at += 1;
    } else if (quote === null) {
      quote = char === "'" || char === '"' ? char : null;
      blanked += quote === null ? char : '_';
    } else {
      quote = char === quote ? null : quote;
      blanked += '_';
    }
  }
  return blanked;
}

interface Part {
  bare: string;
  text: string;
}

function cut(part: Part, separator: RegExp): Part[] {
  const parts: Part[] = [];
  let from = 0;
  for (const match of part.bare.matchAll(separator)) {
    parts.push({
      bare: part.bare.slice(from, match.index),
      text: part.text.slice(from, match.index),
    });
    from = match.index + match[0].length;
  }
  parts.push({ bare: part.bare.slice(from), text: part.text.slice(from) });
  return parts;
}

function stopsEarly({ bare, text }: Part): boolean {
  return (
    GREP_THAT_STOPS.test(bare) ||
    HEAD.test(bare) ||
    (SED.test(bare) && SED_QUIT.test(text)) ||
    (AWK.test(bare) && AWK_EXIT.test(text))
  );
}

/**
 * Whether the line pipes `tail -f` into a reader that stops early. `tail` learns
 * its reader left only from a failed write, so once the file stops growing the
 * pipeline, and whatever follows it on the line, waits for the timeout.
 */
export function followsPastItsReader(command: string): boolean {
  const line = { bare: blankQuotes(command), text: command };
  return cut(line, /\|\||&&|;|(?<![>&])&(?!>)|\n/g).some((pipeline) => {
    const stages = cut(pipeline, /\|/g);
    const tail = stages.findIndex(({ bare }) => FOLLOWING_TAIL.test(bare));
    return tail !== -1 && stages.slice(tail + 1).some(stopsEarly);
  });
}

/** Refused rather than clamped: a cut-down timeout is not the one asked for. */
const MonitorArgsSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, 'command is empty')
      .max(MONITOR_COMMAND_MAX)
      .refine(
        (value) => !CONTROL.test(value),
        'command holds a control character',
      )
      .refine(
        (value) => !followsPastItsReader(value),
        'this command would not end: `tail -f` notices its reader has stopped only when it next writes, so once the file stops growing the pipeline waits for the timeout. Wait for the line with a loop instead, e.g. `until grep -q DONE app.log; do sleep 5; done; grep DONE app.log`',
      ),
    description: z
      .string()
      .trim()
      .min(1, 'description is empty')
      .max(MONITOR_DESCRIPTION_MAX)
      .refine(
        (value) => !CONTROL.test(value) && !value.includes('\n'),
        'description must be one line without control characters',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(MONITOR_TIMEOUT_MIN_MS)
      .max(MONITOR_TIMEOUT_MAX_MS)
      .optional(),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readMonitor(
  args: Record<string, unknown>,
): MonitorStartInput | { error: string } {
  const read = readToolArgs(MonitorArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  return {
    command: read.query.command,
    description: read.query.description,
    timeoutMs: read.query.timeout_ms ?? MONITOR_TIMEOUT_DEFAULT_MS,
  };
}

/** The receipt for a start that was not refused. */
export function monitorResultText(
  outcome:
    Exclude<MonitorStartOutcome, { status: 'refused' }> | HostSinkUnavailable,
): string {
  if (outcome.status === 'unavailable') {
    return `Not started: ${outcome.reason}.`;
  }
  const started = `Started monitor ${outcome.id}. Its output arrives as your next turns — end this turn rather than wait.`;
  if (outcome.alsoRunning.length === 0) {
    return started;
  }
  const others = outcome.alsoRunning
    .map(({ id, description }) => `${id} (${description})`)
    .join(', ');
  return `${started} You also have running: ${others}. A monitor does not end because a newer one started, so if this one replaces any of them, stop it with stop_monitor.`;
}
