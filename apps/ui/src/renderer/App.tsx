import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DaemonHandle } from '../shared/contracts';
import { Chats } from './chats/Chats';
import { ConnectionBanner } from './components/connection-banner';
import { EmptyState } from './components/empty-state';
import { type AppView, NavRail } from './components/nav-rail';
import { cn } from './components/ui/utils';
import { WindowDragStrip } from './components/window-drag-strip';
import { createDaemonApis } from './daemon-api';
import { DaemonClient } from './daemon-client';
import { DebugPanel } from './debug/debug-panel';
import { reportUiErrors } from './debug/report-ui-errors';
import { Onboarding } from './onboarding/Onboarding';
import { footerUpdate } from './updates/update-status';
import { useUpdateState } from './updates/use-update-state';

// Code-split the conditionally-rendered views: Graphs drags @xyflow/react +
// elkjs and Settings its own tree — eager imports would put both in the
// startup chunk of the always-mounted shell.
const Graphs = lazy(() =>
  import('./graphs/Graphs').then((m) => ({ default: m.Graphs })),
);
const Settings = lazy(() =>
  import('./settings/Settings').then((m) => ({ default: m.Settings })),
);
const Stats = lazy(() =>
  import('./stats/Stats').then((m) => ({ default: m.Stats })),
);

type Phase = 'loading' | 'onboarding' | 'ready';

/** The daemon's `hello` event payload (`{ version }`), sent on connect. */
function helloVersion(data: unknown): string | null {
  if (typeof data === 'object' && data !== null) {
    const version = (data as { version?: unknown }).version;
    if (typeof version === 'string') {
      return version;
    }
  }
  return null;
}

export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<AppView>('chats');
  // Graphs mounts lazily on first visit, then stays mounted (hidden) like
  // Chats — unmounting on nav used to silently discard every unsaved builder
  // edit when the user glanced at Chats/Settings mid-composition.
  const [graphsMounted, setGraphsMounted] = useState(false);
  if (view === 'graphs' && !graphsMounted) {
    setGraphsMounted(true);
  }
  const [connected, setConnected] = useState(false);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  const [handle, setHandle] = useState<DaemonHandle | null>(null);
  /**
   * Why the daemon is not answering, in its own words. Held even while a retry
   * is in flight — clearing it on every attempt would blank the one sentence
   * explaining the failure several times a second, since Socket.IO retries on
   * its own schedule.
   */
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  /**
   * Whether the user has pressed the rail's update control this launch.
   *
   * The only thing that turns a failed install into something the status row
   * reports: a background CHECK that could not reach GitHub is not a fault
   * they asked about. There is no longer a DISMISSED version beside it — the
   * offer lives in the status row now, at the size of the row, so there is
   * nothing to wave away and nothing interrupting a view to be waved away from.
   */
  const [updateEngaged, setUpdateEngaged] = useState(false);
  const update = useUpdateState();
  const clientRef = useRef<DaemonClient | null>(null);
  // One set of clients per launch handle. Built here rather than inside the
  // panel so a toggle does not construct five API objects, and so the UI error
  // reporter below can share them.
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );

  const attachDaemon = useCallback((daemonHandle: DaemonHandle): void => {
    // Published for the DevTools extension's Geniro panel, which runs in an
    // extension origin with no preload and no module graph of ours — its only
    // channel to this page is `inspectedWindow.eval`, so the host, port and
    // per-launch token have to be reachable from a plain global. Re-published
    // on every attach because a daemon restart rotates the token, and a panel
    // holding the old one would be silently unauthorised.
    //
    // Not a leak: this is a loopback session token the renderer already holds
    // and sends on every request, in a window only this app loads.
    (window as unknown as { __geniroDaemon: DaemonHandle }).__geniroDaemon =
      daemonHandle;
    clientRef.current?.close();
    setConnected(false);
    const client = new DaemonClient(daemonHandle, {
      onOpen: () => {
        setConnected(true);
        // Cleared only on a connection that actually OPENED — the one event
        // that proves the previous reason no longer holds.
        setConnectionError(null);
      },
      onClose: (reason) => {
        setConnected(false);
        setConnectionError(`The connection dropped (${reason}).`);
      },
      onError: (message) => {
        setConnected(false);
        setConnectionError(message);
      },
      onMessage: (event, data) => {
        if (event === 'hello') {
          const version = helloVersion(data);
          if (version) {
            setDaemonVersion(version);
          }
        }
      },
    });
    clientRef.current = client;
    client.connect();
    setHandle(daemonHandle);
  }, []);

  const connectDaemon = useCallback(async (): Promise<void> => {
    setReconnecting(true);
    try {
      const daemonHandle = await window.geniro.getDaemonHandle();
      if (!daemonHandle) {
        setConnected(false);
        // A missing handle is a DIFFERENT failure from a refused socket: there
        // is no address to dial, because the supervisor never got the daemon
        // to a healthy listen. Said in those terms rather than left as
        // silence, which is what it was — the app simply showed an empty
        // shell.
        setConnectionError(
          'The local engine has not started yet, so there is nothing to connect to.',
        );
        return;
      }
      attachDaemon(daemonHandle);
    } catch (err) {
      setConnected(false);
      setConnectionError(
        err instanceof Error
          ? err.message
          : 'Could not reach the local engine.',
      );
    } finally {
      setReconnecting(false);
    }
  }, [attachDaemon]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribeRestart = window.geniro.onDaemonRestarted(attachDaemon);
    void window.geniro.getStatus().then((status) => {
      if (cancelled) {
        return;
      }
      if (status.onboardingComplete) {
        setPhase('ready');
        void connectDaemon();
      } else {
        setPhase('onboarding');
      }
    });
    return () => {
      cancelled = true;
      unsubscribeRestart();
      clientRef.current?.close();
    };
  }, [attachDaemon, connectDaemon]);

  const handleOnboardingDone = useCallback((): void => {
    setPhase('ready');
    void connectDaemon();
  }, [connectDaemon]);

  // This window's uncaught errors go to the daemon's log, so they outlive the
  // console and sit in order beside what the daemon was doing.
  useEffect(() => {
    if (!apis) {
      return;
    }
    return reportUiErrors(apis);
  }, [apis]);

  // A clicked notification is always about a CHAT, so it brings the chat view
  // with it — main has already raised the window, and landing the user on
  // Settings with a raised window would be a banner that went nowhere. Which
  // thread it opens is `Chats`' own listener on the same channel; it is split
  // that way because the view is app state and the active run is not.
  useEffect(
    () => window.geniro.onNotificationActivated(() => setView('chats')),
    [],
  );

  // ⌥⌘L for the debug drawer. A shortcut and not only a button because the
  // moment you want it is usually the moment something is already misbehaving,
  // and reaching for a control with the pointer is what you do afterwards.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // `event.code`, not `event.key`: with Alt held, macOS rewrites the key
      // for an `l` to `¬`, so matching on the character never fires.
      if (event.altKey && event.metaKey && event.code === 'KeyL') {
        event.preventDefault();
        setDebugOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Both of these render before the shell exists, so neither has a top row of
  // its own to drag the window by — see `WindowDragStrip`.
  if (phase === 'loading') {
    return (
      <>
        <WindowDragStrip />
        <EmptyState>Loading…</EmptyState>
      </>
    );
  }

  if (phase === 'onboarding') {
    return (
      <>
        <WindowDragStrip />
        <Onboarding onDone={handleOnboardingDone} />
      </>
    );
  }

  return (
    <div className="flex h-full">
      <NavRail
        view={view}
        onNavigate={setView}
        connected={connected}
        // The offer, resolved HERE from main's one state so the rail renders it
        // rather than deciding it — including `canInstall`, main's own answer
        // about this install (read-only volume, another account, a translocated
        // copy), so the control only appears where pressing it can work.
        update={footerUpdate(update.state, updateEngaged)}
        onInstallUpdate={() => {
          setUpdateEngaged(true);
          void update.install();
        }}
        onRelaunchUpdate={() => void update.relaunch()}
        daemonVersion={daemonVersion}
        debugOpen={debugOpen}
        onToggleDebug={() => setDebugOpen((open) => !open)}
      />
      {/* min-w-0 + overflow-hidden: a flex child's min-width defaults to its
          content, so one long unbreakable string (a cwd path) would otherwise
          push the whole layout wider than the window and the transcript
          auto-scroll would then drag the document sideways, clipping the rail. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Above every view, because every view is made of daemon calls: a
            failure here explains an empty chat list, a Send that does nothing
            and a builder that cannot save, all at once. Outside the per-view
            wrappers so it survives a nav switch — the connection is app state,
            not any one screen's. */}
        {connected ? null : (
          <ConnectionBanner
            reason={connectionError}
            retrying={reconnecting}
            onRetry={() => void connectDaemon()}
          />
        )}
        {/* No update strip here. It and the nav rail's version row were two
            controls for one action in one window; the row is where the running
            version is already written, so that is the one that stayed. The
            connection banner above is NOT the same case and keeps its strip: a
            daemon that is not answering breaks the view under it, while an
            update is an offer with no deadline. */}
        {/* Chats stays mounted (hidden) across nav switches so its live WS room
            and active-run selection survive a trip to Settings/Graphs. */}
        <div className={cn('min-h-0 flex-1', view !== 'chats' && 'hidden')}>
          {handle && clientRef.current ? (
            <Chats
              client={clientRef.current}
              handle={handle}
              active={view === 'chats'}
            />
          ) : (
            <EmptyState>Connecting to the daemon…</EmptyState>
          )}
        </div>
        <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
          {/* `min-h-0 flex-1`, not `h-full`: `main` is now a flex COLUMN whose
              first child can be the connection strip, so a child claiming the
              full height would push the views past the bottom of the window
              by exactly the strip's height. */}
          <div className={cn('min-h-0 flex-1', view !== 'graphs' && 'hidden')}>
            {graphsMounted ? <Graphs handle={handle} /> : null}
          </div>
          {/* Unmounted when hidden, like Settings and unlike Chats/Graphs:
              the page holds no unsaved edit and no live subscription, and a
              fresh mount is how a revisit gets figures that are current
              rather than however stale the last visit left them. */}
          {view === 'stats' ? (
            <div className="min-h-0 flex-1">
              <Stats handle={handle} client={clientRef.current} />
            </div>
          ) : null}
          {view === 'settings' ? (
            <div className="min-h-0 flex-1">
              <Settings handle={handle} />
            </div>
          ) : null}
        </Suspense>
        {/* BELOW the views and inside `main`, so it spans whatever screen is
            open rather than belonging to one — the question it answers ("what
            just happened when I did that") is always about the thing still on
            screen above it. Mounted only while open: mounting it hidden would
            keep the daemon streaming every agent-stdio line to a panel nobody
            is looking at. */}
        {debugOpen && apis && clientRef.current ? (
          <DebugPanel
            apis={apis}
            client={clientRef.current}
            onClose={() => setDebugOpen(false)}
          />
        ) : null}
      </main>
    </div>
  );
}
