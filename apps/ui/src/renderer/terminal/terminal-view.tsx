import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '../../shared/contracts';
import { cn } from '../components/ui/utils';
import { subscribeTerminal } from './terminal-events';
import { readTerminalFont, readTerminalTheme } from './terminal-theme';

/** How a tab's shell ended — or that there never was one. */
export type TerminalEnding =
  | {
      kind: 'exited';
      exitCode: number;
      signal: number | null;
      /** Whether the user typed or pasted anything into this shell. */
      used: boolean;
    }
  | { kind: 'failed-to-start' };

/** Electron prefixes a rejected handler's error with the channel it came from. */
function ipcReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}

/**
 * One tab's emulator, wired to one shell in the main process.
 *
 * The shell's id is minted per MOUNT rather than taken from the tab: an effect
 * that runs twice (StrictMode, a remount) must start a second shell rather than
 * ask main for an id whose first shell is still hanging up.
 *
 * Kept mounted while its tab is in the background or the panel is hidden, so the
 * scrollback — and every byte the shell writes meanwhile — survives.
 */
export default function TerminalView({
  cwd,
  shown,
  onEnded,
}: {
  cwd: string | null;
  /** This tab is the selected one AND the panel is open. */
  shown: boolean;
  onEnded: (ending: TerminalEnding) => void;
}): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const refitRef = useRef<() => void>(() => undefined);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const surface = surfaceRef.current;
    const host = hostRef.current;
    if (!surface || !host) {
      return;
    }
    const id = crypto.randomUUID();
    let ended = false;
    let used = false;
    const term = new Terminal({
      fontFamily: readTerminalFont(),
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5_000,
      theme: readTerminalTheme(surface),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    const refit = (): void => {
      // A hidden panel measures 0×0, and fitting to that collapses the shell to
      // one column — its output would then be wrapped for good.
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        fit.fit();
      }
    };
    refitRef.current = refit;
    refit();

    const report = (what: string) => (err: unknown) => {
      term.write(`\r\n[${what}: ${ipcReason(err)}]\r\n`);
    };
    // A very wide window fits more columns than main accepts; the shell then
    // runs at the cap rather than being refused.
    const sendSize = (cols: number, rows: number): void => {
      void window.geniro
        .terminalResize(
          id,
          Math.min(cols, TERMINAL_MAX_COLS),
          Math.min(rows, TERMINAL_MAX_ROWS),
        )
        .catch(report('could not resize the shell'));
    };

    // Output is acknowledged once DRAWN, which is what tells main how far behind
    // the screen a fast shell has run. Except while the window is hidden: xterm
    // draws on timers Chromium throttles to one a second (one a minute after
    // five), and a build left running behind another app would crawl. So a
    // hidden window acknowledges on receipt, and going hidden acknowledges
    // whatever was still waiting to be drawn; xterm's own write buffer bounds
    // what piles up meanwhile.
    const undrawn = new Set<{ chars: number }>();
    const acknowledge = (batch: { chars: number }): void => {
      if (undrawn.delete(batch) && !ended) {
        void window.geniro
          .terminalAck(id, batch.chars)
          .catch(report('output flow control failed'));
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        [...undrawn].forEach(acknowledge);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const unsubscribe = subscribeTerminal(id, {
      data: (data) => {
        const batch = { chars: data.length };
        undrawn.add(batch);
        term.write(data, () => acknowledge(batch));
        if (document.visibilityState === 'hidden') {
          acknowledge(batch);
        }
      },
      exit: ({ exitCode, signal }) => {
        ended = true;
        term.write(
          signal === null
            ? `\r\n[Process exited with code ${exitCode}]\r\n`
            : `\r\n[Process killed by signal ${signal}]\r\n`,
        );
        onEndedRef.current({ kind: 'exited', exitCode, signal, used });
      },
    });
    const input = term.onData((data) => {
      if (!ended) {
        void window.geniro
          .terminalWrite(id, data)
          .catch(report('input was not sent'));
      }
    });
    // Keys and pastes only — never `onData`, which also carries the terminal's
    // own answers to queries a prompt sends while the shell starts.
    const keyed = term.onKey(() => {
      used = true;
    });
    const onPaste = (): void => {
      used = true;
    };
    host.addEventListener('paste', onPaste, true);
    const resized = term.onResize(({ cols, rows }) => {
      if (!ended) {
        sendSize(cols, rows);
      }
    });

    void window.geniro
      .terminalCreate({
        id,
        ...(cwd === null ? {} : { cwd }),
        cols: Math.min(term.cols, TERMINAL_MAX_COLS),
        rows: Math.min(term.rows, TERMINAL_MAX_ROWS),
      })
      .then(() => {
        // The panel may have been measured again while the shell started.
        if (!ended) {
          sendSize(term.cols, term.rows);
        }
      })
      .catch((err: unknown) => {
        ended = true;
        term.write(`Could not start a shell: ${ipcReason(err)}\r\n`);
        onEndedRef.current({ kind: 'failed-to-start' });
      });

    const sizeWatch = new ResizeObserver(refit);
    sizeWatch.observe(host);
    // The theme lives on `<html data-theme>`; a switch repaints the page through
    // CSS alone, and this surface is the one that needs telling.
    const themeWatch = new MutationObserver(() => {
      term.options.theme = readTerminalTheme(surface);
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      sizeWatch.disconnect();
      themeWatch.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      input.dispose();
      keyed.dispose();
      host.removeEventListener('paste', onPaste, true);
      resized.dispose();
      unsubscribe();
      if (!ended) {
        // The tab is gone, so there is nowhere left to report a failed hang-up.
        void window.geniro.terminalKill(id).catch(() => undefined);
      }
      termRef.current = null;
      refitRef.current = () => undefined;
      term.dispose();
    };
    // `cwd` is where the shell STARTED; a tab never moves its shell.
  }, []);

  useEffect(() => {
    if (!shown) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      refitRef.current();
      // A tab becomes shown when its neighbour closes, which can happen while
      // the user is typing a tab's name — focusing the terminal then would end
      // that edit and save whatever was typed so far. That field alone: opening
      // the panel from any other input is asking for the shell.
      const active = document.activeElement;
      if (!(
        active instanceof Element &&
        active.closest('[data-slot="inline-rename"]')
      )) {
        termRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  // The padding lives on the SURFACE, never on the host: the fit addon sizes the
  // grid to its host's full box, so padding there pushes the last row off the
  // bottom of the panel.
  return (
    <div
      ref={surfaceRef}
      className={cn(
        'flex min-h-0 flex-1 bg-card px-2 pt-1 text-foreground',
        !shown && 'hidden',
      )}>
      <div ref={hostRef} className="min-h-0 min-w-0 flex-1" />
    </div>
  );
}
