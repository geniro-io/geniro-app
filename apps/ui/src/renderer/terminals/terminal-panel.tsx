import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  DaemonHandle,
  TerminalSession,
  TerminalStatus,
} from '../../shared/contracts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TerminalClient } from '../terminal-client';

/** Resolve a design token to the concrete colour value xterm can parse. */
function tokenColor(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Modal popup showing one live PTY mirror: the agent's original TUI,
 * byte-for-byte, in an xterm.js view over a dimmed backdrop. Colours come
 * from the design tokens (resolved at mount — xterm needs concrete values,
 * not var() references). Closing — the ✕ or a backdrop click — always
 * DETACHES (the session keeps running for a later re-open); ending a session
 * happens inside the TUI itself (exit the REPL), never from this chrome.
 * Escape deliberately does NOT close: the key belongs to the TUI inside
 * (claude uses it to interrupt).
 */
export function TerminalPanel({
  handle,
  session,
  title,
  onClose,
}: {
  handle: DaemonHandle;
  session: TerminalSession;
  /** Header label, e.g. "claude · run title" or the node id. */
  title: string;
  onClose: () => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [status, setStatus] = useState<TerminalStatus>(session.status);
  const [gone, setGone] = useState(false);
  // False until the attach delivers its first snapshot/data/exit — a blank
  // card under a "live" badge reads as broken, so surface "Connecting…".
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // A session swap re-runs this effect with a fresh client — back to
    // connecting until the new attach replies.
    setConnected(false);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: tokenColor('--card'),
        foreground: tokenColor('--foreground'),
        cursor: tokenColor('--primary'),
        selectionBackground: tokenColor('--accent'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    // xterm's open() does not focus. Without this, keystrokes stay on the
    // background trigger button under the modal (Space would re-fire it) and
    // typing does nothing until the user clicks inside the terminal.
    term.focus();

    const client = new TerminalClient(handle, session.id, {
      onSnapshot: (snapshot, snapshotStatus, code) => {
        setConnected(true);
        setGone(false);
        // A reconnect replays the full buffer — reset so nothing doubles.
        term.reset();
        term.write(snapshot);
        // Set (not just flip) the badge from the snapshot's status: Chats can
        // swap the session prop in place, and a fresh running session must not
        // inherit the previous session's "exited" badge.
        setStatus(snapshotStatus);
        setExitCode(snapshotStatus === 'exited' ? code : null);
        client.resize(term.cols, term.rows);
        // (Re)attach lands the mirror live — keys must route to the PTY.
        term.focus();
      },
      onData: (data) => {
        setConnected(true);
        term.write(data);
      },
      onExit: (code) => {
        setConnected(true);
        setStatus('exited');
        setExitCode(code);
      },
      // The session was disposed/reaped before this attach — flag it so the
      // header stops showing a "live" badge over an inert terminal.
      onGone: () => setGone(true),
    });
    client.connect();

    const dataSub = term.onData((data) => client.input(data));
    const observer = new ResizeObserver(() => {
      fit.fit();
      client.resize(term.cols, term.rows);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      client.close();
      term.dispose();
    };
  }, [handle, session.id]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-foreground/30"
        aria-hidden="true"
        data-testid="terminal-backdrop"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-[78vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-panel-md">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          {/* A healthy live mirror needs no badge — only the exceptional
              states (still connecting, ended, reaped) get labeled. */}
          {gone ? (
            <Badge variant="secondary">gone</Badge>
          ) : !connected ? (
            <Badge variant="secondary">connecting</Badge>
          ) : status === 'exited' ? (
            <Badge variant="secondary">
              exited{exitCode !== null ? ` (${exitCode})` : ''}
            </Badge>
          ) : status === 'closing' ? (
            <Badge variant="secondary">closing</Badge>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label="Close terminal"
            title="Close">
            <X className="size-4 shrink-0" />
          </Button>
        </header>
        <div className="relative min-h-0 flex-1">
          {!connected && !gone ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
              Connecting…
            </div>
          ) : null}
          <div ref={containerRef} className="h-full bg-card p-2" />
        </div>
      </div>
    </div>
  );
}
