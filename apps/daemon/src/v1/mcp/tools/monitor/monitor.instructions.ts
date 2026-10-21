import {
  MONITOR_DESCRIPTION_MAX,
  MONITOR_RUN_MAX,
  MONITOR_TIMEOUT_DEFAULT_MS,
  MONITOR_TIMEOUT_MAX_MS,
} from '../../../agents/chat.types';
import {
  MONITOR_BATCH_WINDOW_MS,
  MONITOR_EVENT_MAX_BYTES,
  MONITOR_EVENT_MAX_LINES,
  MONITOR_FLOOD_MAX_BYTES,
  MONITOR_FLOOD_MAX_LINES,
  MONITOR_FLOOD_WINDOW_MS,
  MONITOR_LINE_MAX_CHARS,
} from '../../../agents/utils/monitor-batcher';

/** What a model reads about `monitor`. */
export function monitorInstructions(): string {
  return (
    'Run a shell command in the background and be woken with what it prints, instead of waiting ' +
    'with sleep-and-poll loops. Use it to wait on something slow that reports as it goes — a CI ' +
    'run (`gh run watch <id> --exit-status`), a long build or test run, a log you need a line from ' +
    '(`tail -f app.log | grep --line-buffered ERROR`). Do not use it for a command that finishes ' +
    'in seconds (run that with your shell tool) or to keep a server running (start that detached). ' +
    "It returns at once with the monitor's id (`m1`, `m2`, …); end your turn rather than wait. " +
    'What the command prints arrives as your next turn, after the current one, in a ' +
    '`<message from="<description> · monitor" monitor="m1">` block — the command\'s output, not ' +
    "the user's words. The last one says how it ended (`· exit code 0`, `· timed out`, `· stopped`). " +
    `stdout and stderr are read together. Output is gathered for ${MONITOR_BATCH_WINDOW_MS} ms at a time; one ` +
    `message carries at most ${MONITOR_EVENT_MAX_LINES} lines or ${MONITOR_EVENT_MAX_BYTES / 1024} KiB (the rest is ` +
    `counted, not sent), and a line is cut at ${MONITOR_LINE_MAX_CHARS} characters. Output that arrives while you ` +
    'are working waits and is merged into one message. ' +
    `A command printing more than ${MONITOR_FLOOD_MAX_LINES} lines or ${MONITOR_FLOOD_MAX_BYTES / 1024} KiB within ` +
    `${MONITOR_FLOOD_WINDOW_MS / 1000} s is stopped as flooded: filter it with \`grep --line-buffered\` and start it again. ` +
    `It is stopped after \`timeout_ms\` (default ${MONITOR_TIMEOUT_DEFAULT_MS / 60_000} minutes, at most ` +
    `${MONITOR_TIMEOUT_MAX_MS / 60_000}). A thread runs at most ${MONITOR_RUN_MAX} monitors at once. ` +
    "It runs in this conversation's folder, under `/bin/sh`. Stop one early with stop_monitor; " +
    `list_monitors names the ones still running. \`description\` (at most ${MONITOR_DESCRIPTION_MAX} characters) is ` +
    'how the user and you will tell its messages apart, e.g. "CI run 4812".'
  );
}
