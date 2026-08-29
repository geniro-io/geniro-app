import { useEffect, useRef, useState } from 'react';

import { CopyButton } from '../components/copy-button';
import { ErrorText } from '../components/error-text';
import { stripAnsi } from '../components/ui/ansi';
import { AnsiText } from '../components/ui/ansi-text';
import { Dialog } from '../components/ui/dialog';
import { Spinner } from '../components/ui/spinner';
import { formatElapsed } from './live-row';
import { RUN_STATUS_META } from './run-status';
import { RUN_STATUS_OF_SHELL, type ShellRun } from './shell-activity';

/**
 * The TERMINAL behind one command — what a shell in the panel has printed.
 *
 * The ask: a row in the running-shells list should open onto the command's own
 * output. Two sources answer it and the daemon picks between them, because the
 * difference is not something a reader should have to know: a DETACHED
 * command's output is a file the CLI is still appending to (tailed, so the view
 * follows a `pnpm dev` as it starts up), a FOREGROUND one's is the tool reply
 * already in the transcript.
 *
 * POLLED while the command is running, and only then. It is a bounded read of
 * one file — unlike the context breakdown next door, which is a multi-second
 * round trip to the live CLI and is therefore fetched once per open — so the
 * cost of keeping it current is a fetch every couple of seconds against a
 * dialog the user has deliberately opened. A finished command is read once:
 * nothing more can arrive.
 */

/** How often a running command's output is re-read. */
const POLL_MS = 2_000;

export function ShellOutputDialog({
  shell,
  onClose,
  load,
}: {
  /** The command to show, or null when nothing is open. */
  shell: ShellRun | null;
  onClose: () => void;
  /** Read this run's output for one tool call. */
  load: (callId: string) => Promise<{
    text: string;
    truncated: boolean;
    unavailableReason: string | null;
  }>;
}): React.JSX.Element | null {
  const [text, setText] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLPreElement | null>(null);
  // Whether the view is pinned to the newest line. A reader who scrolled UP is
  // reading something, and a poll that yanked them back to the bottom every two
  // seconds would make a long log unreadable — the same rule the transcript's
  // own follow obeys.
  const [pinned, setPinned] = useState(true);
  const callId = shell?.id ?? null;
  const live = shell?.status === 'running';

  useEffect(() => {
    if (callId === null) {
      return;
    }
    let cancelled = false;
    // Blank between COMMANDS, never between polls of one: the second case is a
    // refresh of what is on screen, and clearing it would flash the panel empty
    // twice a second.
    setText('');
    setTruncated(false);
    setReason(null);
    setError(null);
    setPinned(true);
    const read = async (): Promise<void> => {
      setLoading(true);
      try {
        const output = await load(callId);
        if (cancelled) {
          return;
        }
        setText(output.text);
        setTruncated(output.truncated);
        setReason(output.unavailableReason);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void read();
    if (!live) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [callId, live, load]);

  useEffect(() => {
    const box = boxRef.current;
    if (box !== null && pinned) {
      // A direct assignment rather than `followTail`: this is a 24rem box a
      // poll refills every two seconds, and the write is the whole operation.
      // The same assignment `TaskScrollRows` makes on its own box.
      //
      // This comment used to say the shared helper "animates", which was the
      // reason to avoid it — and that was true, and was ALSO the bug: the
      // transcript's own tail-follow animated too, re-issued per streamed chunk,
      // and never moved at all. `followTail` no longer takes a behaviour (see
      // `scroll-to-bottom.ts`), so the hazard this box sidestepped locally is
      // gone everywhere.
      box.scrollTop = box.scrollHeight;
    }
  }, [text, pinned]);

  if (shell === null) {
    return null;
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          {live ? <Spinner className="size-3.5 shrink-0 text-primary" /> : null}
          <span className="min-w-0 truncate">Shell output</span>
        </span>
      }
      className="w-full max-w-3xl">
      <div className="flex min-w-0 flex-col gap-2">
        {/* The command itself, in full and copyable — the panel row truncates
            it to one line, and this is the surface where the whole thing fits. */}
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
            {shell.command}
          </code>
          <CopyButton text={shell.command} label="Copy the command" />
        </div>
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          {/* Translated, never printed: `ShellStatus` is a model and
              `RUN_STATUS_META` holds the one word each state is spelled with,
              so a killed command reads `cancelled` here exactly as it does on
              the block beside it. */}
          <span>
            {
              RUN_STATUS_META[
                live ? 'running' : RUN_STATUS_OF_SHELL[shell.status]
              ].label
            }
          </span>
          {shell.background ? <span>· detached</span> : null}
          {shell.exitCode === null ? null : (
            <span>· exit {shell.exitCode}</span>
          )}
          <span>· {startedLabel(shell.startedAt)}</span>
          {shell.description === null ? null : (
            <span>· {shell.description}</span>
          )}
          {text === '' ? null : (
            <span className="ml-auto flex items-center">
              {/* The output as CHARACTERS — `stripAnsi`, not the raw text. The
                  spans below are for the eye; what a reader pastes into a bug
                  report must not carry the codes that coloured them. */}
              <CopyButton text={stripAnsi(text)} label="Copy the output" />
            </span>
          )}
        </p>
        {reason === null ? (
          <pre
            ref={boxRef}
            data-slot="shell-output"
            // Scroll state is READ on every scroll rather than only at the top:
            // "is the reader at the bottom" is what decides whether the next
            // poll follows, and it changes with the wheel, not with a prop.
            onScroll={(event) => {
              const box = event.currentTarget;
              setPinned(
                box.scrollHeight - box.scrollTop - box.clientHeight < 24,
              );
            }}
            className="m-0 max-h-[24rem] min-h-[8rem] overflow-auto rounded-lg border border-border bg-card p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
            {text === '' && loading ? (
              'Reading…'
            ) : (
              // The command's OWN colours. A shell writes them as escape
              // sequences, and rendered as text the escape byte is invisible
              // while its tail is not — a coloured log read as `[32mok[0m`,
              // corrupted rather than coloured, which is what this replaced.
              <AnsiText text={text} />
            )}
          </pre>
        ) : (
          <p className="m-0 rounded-lg border border-border bg-card p-2.5 text-xs text-muted-foreground">
            {reason}
          </p>
        )}
        {truncated ? (
          // Said out loud: a tail that silently began mid-file reads as the
          // whole output, and a reader looking for a line that scrolled past
          // would conclude it was never printed.
          <p className="m-0 text-[11px] text-muted-foreground">
            Showing the end of a longer output — earlier lines are in the file
            the command is writing.
          </p>
        ) : null}
        {error === null ? null : (
          <ErrorText className="text-xs">{error}</ErrorText>
        )}
      </div>
    </Dialog>
  );
}

/** `running for 2m 10s`, or `started 2m 10s ago` once it has stopped. */
function startedLabel(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) {
    return 'start time unknown';
  }
  return `${formatElapsed(Date.now() - started)} ago`;
}
