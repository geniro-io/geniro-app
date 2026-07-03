import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import type { DaemonHandle, TerminalSession } from '../../shared/contracts';
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
 * Right-side drawer showing one live PTY mirror: the agent's original TUI,
 * byte-for-byte, in an xterm.js view. Colours come from the design tokens
 * (resolved at mount — xterm needs concrete values, not var() references).
 * Closing DETACHES (the session keeps running for a later re-open); "End
 * session" kills the PTY via the REST dispose route.
 */
export function TerminalPanel({
  handle,
  session,
  title,
  onClose,
  onEndSession,
}: {
  handle: DaemonHandle;
  session: TerminalSession;
  /** Header label, e.g. "claude · run title" or the node id. */
  title: string;
  onClose: () => void;
  /** Kill the PTY (REST dispose) — the panel only reports the click. */
  onEndSession: () => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [exited, setExited] = useState(session.status === 'exited');
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
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

    const client = new TerminalClient(handle, session.id, {
      onSnapshot: (snapshot, status, code) => {
        setGone(false);
        // A reconnect replays the full buffer — reset so nothing doubles.
        term.reset();
        term.write(snapshot);
        // Set (not just flip) the badge from the snapshot's status: Chats can
        // swap the session prop in place, and a fresh running session must not
        // inherit the previous session's "exited" badge.
        const isExited = status === 'exited';
        setExited(isExited);
        setExitCode(isExited ? code : null);
        client.resize(term.cols, term.rows);
      },
      onData: (data) => term.write(data),
      onExit: (code) => {
        setExited(true);
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
    <div className="fixed inset-y-0 right-0 z-50 flex w-[620px] max-w-[90vw] flex-col border-l border-border bg-card shadow-[var(--shadow-md)]">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {gone ? (
          <Badge variant="secondary">gone</Badge>
        ) : exited ? (
          <Badge variant="secondary">
            exited{exitCode !== null ? ` (${exitCode})` : ''}
          </Badge>
        ) : (
          <Badge>live</Badge>
        )}
        <Button variant="outline" size="sm" onClick={onEndSession}>
          End session
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close terminal">
          Close
        </Button>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 bg-card p-2" />
    </div>
  );
}
