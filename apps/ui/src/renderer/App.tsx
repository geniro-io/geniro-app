import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { CliKind } from '../shared/contracts';
import type { DaemonHandle } from '../shared/contracts';
import { AgentIdentityContext } from './agent-identity';
import { Chats } from './chats/Chats';
import { AppUsageButton } from './components/app-usage-button';
import { BottomTabBar } from './components/bottom-tab-bar';
import { ConnectionBanner } from './components/connection-banner';
import { EmptyState } from './components/empty-state';
import { type AppView, NavRail } from './components/nav-rail';
import { TitleBar } from './components/title-bar';
import { cn } from './components/ui/utils';
import { useNarrowViewport } from './components/use-narrow-viewport';
import { usePhoneBackEntry } from './components/use-phone-back-entry';
import { useSidebarCollapsed } from './components/use-sidebar-collapsed';
import { WindowDragStrip } from './components/window-drag-strip';
import { createDaemonApis } from './daemon-api';
import { DaemonClient } from './daemon-client';
import { DebugPanel } from './debug/debug-panel';
import { reportUiErrors } from './debug/report-ui-errors';
import type { FirstLaunch, TeamLaunch } from './onboarding/first-launch';
import { Onboarding } from './onboarding/Onboarding';
import { isRemoteRuntime } from './remote/remote-session';
import { formatRoute, parseRoute, type Route } from './routing';
import { answerLineFlush } from './stats/line-flush';
import { TerminalPanel } from './terminal/terminal-panel';
import { useTerminalShortcut } from './terminal/use-terminal-shortcut';
import {
  newTerminalFolder,
  useTerminalTabs,
} from './terminal/use-terminal-tabs';
import { footerUpdate } from './updates/update-status';
import { useUpdateState } from './updates/use-update-state';
import { useAppProcesses } from './use-app-processes';
import {
  CapabilitiesContext,
  useAgentIdentities,
  useCapabilities,
} from './use-capabilities';

// Code-split the conditionally-rendered views: Workflows drags @xyflow/react +
// elkjs and Settings its own tree — eager imports would put both in the
// startup chunk of the always-mounted shell.
const Workflows = lazy(() =>
  import('./workflows/Workflows').then((m) => ({ default: m.Workflows })),
);
import type { SettingsSection } from './settings/Settings';

const Settings = lazy(() =>
  import('./settings/Settings').then((m) => ({ default: m.Settings })),
);
const Stats = lazy(() =>
  import('./stats/Stats').then((m) => ({ default: m.Stats })),
);
const Tasks = lazy(() =>
  import('./tasks/Tasks').then((m) => ({ default: m.Tasks })),
);

type Phase = 'loading' | 'onboarding' | 'ready';

/**
 * What the title bar says for a view that is not a document.
 *
 * Only Chats has a name of its own to show (the open thread); the other three
 * are places rather than things, so the bar states where you are — which is
 * what the OS strip used to do with the app's name and nothing else.
 */
const VIEW_TITLE: Record<AppView, string> = {
  chats: 'Chats',
  workflows: 'Workflows',
  tasks: 'Tasks',
  stats: 'Stats',
  settings: 'Settings',
};

/**
 * The address for this shell's current state — the write half of the hash
 * sync in `App`.
 *
 * `openRunId` is the thread CHATS reports as open, never `threadRequest`.
 * Those look interchangeable and are opposites: the request is inbound and
 * one-shot (Chats clears it through `onRunOpened` the moment it honours it,
 * and a click in its own sidebar never sets it), so an address built from it
 * names a thread for one render and nothing afterwards — which is no address
 * at all for a link meant to be copied and sent.
 *
 * `workflows`/`tasks` pick their own open item internally (the builder's
 * selection, the board's project), so from here they are addressed by view
 * alone.
 */
function currentRoute(view: AppView, openRunId: string | null): Route {
  switch (view) {
    case 'chats':
      return { view: 'chats', runId: openRunId };
    case 'workflows':
      return { view: 'workflows', slug: null };
    case 'tasks':
      return { view: 'tasks', projectId: null };
    case 'settings':
      return { view: 'settings' };
    case 'stats':
      return { view: 'stats' };
  }
}

export function App(): React.JSX.Element {
  // Read once, before the first render decides anything: a pasted link must
  // land on its own view/thread from the FIRST paint, which only a lazy
  // `useState` initialiser can do — a `useEffect` runs after that paint.
  const [initialRoute] = useState(() => parseRoute(window.location.hash));
  const [phase, setPhase] = useState<Phase>('loading');
  const [guideOpen, setGuideOpen] = useState(false);
  const [chatLaunch, setChatLaunch] = useState<CliKind | null>(null);
  const [teamLaunch, setTeamLaunch] = useState<TeamLaunch | null>(null);
  const [view, setView] = useState<AppView>(
    () => initialRoute?.view ?? 'chats',
  );
  /**
   * A thread another view asked to have opened, held until `Chats` takes it.
   *
   * The board's cards each carry a run — a task IS a conversation with an
   * agent — and "open the thread this card is being worked in" therefore has
   * to cross two screens. It is App state for the same reason the view is:
   * `Chats` owns which run is active but not which SCREEN is on show, and a
   * jump has to do both. The same split the notification path already uses,
   * except that one is two independent listeners on one main-process event and
   * this one has no event to share, so the run id travels as a prop and is
   * cleared by the callback once opened.
   *
   * A pasted `#/chats/<runId>` link seeds this the same way: it is a request
   * to open that thread, which `Chats` takes exactly as it takes one from
   * `Tasks`.
   */
  const [threadRequest, setThreadRequest] = useState<string | null>(() =>
    initialRoute?.view === 'chats' ? initialRoute.runId : null,
  );
  /**
   * The thread `Chats` reports as OPEN — the outbound twin of the request
   * above, and the only one of the two the address may be built from.
   *
   * Seeded from a deep link so the first paint's address already names the
   * thread being opened; `Chats` overwrites it the moment it has one.
   */
  const [openRunId, setOpenRunId] = useState<string | null>(() =>
    initialRoute?.view === 'chats' ? initialRoute.runId : null,
  );
  // Workflows mounts lazily on first visit, then stays mounted (hidden) like
  // Chats — unmounting on nav used to silently discard every unsaved builder
  // edit when the user glanced at Chats/Settings mid-composition.
  const [workflowsMounted, setWorkflowsMounted] = useState(false);
  // Same latch, same reason: the board holds a selected project, a scroll
  // position and a half-finished drag, none of which survive a remount.
  const [tasksMounted, setTasksMounted] = useState(false);
  /**
   * Which pane Settings opens on — HERE rather than inside Settings because
   * another screen can ask for one: Settings is unmounted while hidden, so a
   * section it remembered privately would be forgotten between visits and,
   * worse, could not be set from outside at all.
   */
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('general');
  if (view === 'workflows' && !workflowsMounted) {
    setWorkflowsMounted(true);
  }
  if (view === 'tasks' && !tasksMounted) {
    setTasksMounted(true);
  }
  const [connected, setConnected] = useState(false);
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
  const sidebar = useSidebarCollapsed();
  const narrowViewport = useNarrowViewport();
  /**
   * Whether the Chats screen is showing a DETAIL page on a phone — an open
   * thread or the new-chat composer, reported up by `Chats` — which decides
   * what the title bar names.
   */
  const [chatsPhoneDetail, setChatsPhoneDetail] = useState(false);
  /**
   * Bumped when the Chats tab is pressed while Chats is on show: the phone's
   * way back to the chat list, since the tab bar is its only navigation.
   */
  const [chatsHomeSignal, setChatsHomeSignal] = useState(0);
  /**
   * Whether Settings shows a SECTION rather than its list of sections, on a
   * phone. Here rather than inside Settings for `settingsSection`'s reason:
   * Settings is unmounted while hidden, and a jump from another screen
   * ("Manage fast actions") must land in the section, not on the list.
   */
  const [settingsSectionOpen, setSettingsSectionOpen] = useState(false);
  /** Leaves the section for the list — see `usePhoneBackEntry`. */
  const settingsBack = usePhoneBackEntry(
    'settings',
    narrowViewport && view === 'settings' && settingsSectionOpen,
    () => setSettingsSectionOpen(false),
  );
  /**
   * What the open chat is called, reported UP by `Chats`.
   *
   * The title bar spans the window, above the columns, so the name of the thing
   * on screen has to reach it from the view that knows it. Null until a chat is
   * open — the landing view is not a document and says so by name.
   */
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const terminals = useTerminalTabs();
  /** The open thread's folder, reported up by `Chats` — where a new terminal starts. */
  const [chatFolder, setChatFolder] = useState<string | null>(null);
  const update = useUpdateState();
  const clientRef = useRef<DaemonClient | null>(null);
  // One set of clients per launch handle. Built here rather than inside the
  // panel so a toggle does not construct five API objects, and so the UI error
  // reporter below can share them.
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );
  // The app's ONE capabilities read, provided around every view — the whole
  // answer, and the agent identities out of it — so no screen reads it again.
  const capabilities = useCapabilities(apis?.capabilities ?? null);
  /** Whether the title bar's usage panel is open — the only time it polls. */
  const [usageOpen, setUsageOpen] = useState(false);
  const appProcesses = useAppProcesses(apis, usageOpen);
  const agentIdentities = useAgentIdentities(capabilities.capabilities);

  /**
   * The menu bar's Clear Agent Cache: forget, then RELOAD.
   *
   * The reload is the whole of the renderer's half. `useAgentVocabulary`
   * caches per hook INSTANCE — the composer holds three, the graph inspector
   * three more — so the daemon forgetting is only half a press, and a reload
   * drops every one of them along with the rest of this window's state. It
   * also replaced the confirmation line this first shipped with, on the
   * report: "нам не нужно вот это добавлять… просто должен перезагружать".
   * A reload is its own confirmation, and it costs the composer's unsent text,
   * which is the trade the row is understood to make.
   *
   * ONLY after the daemon has answered, and never on a failure: reloading
   * first would refill the caches from the daemon that has not cleared them
   * yet, and reloading after one would hide the failure behind a window that
   * looks like it worked. A failure goes to the daemon's log instead, which is
   * where every other renderer failure goes.
   */
  const clearAgentCaches = useCallback((): void => {
    if (!apis) {
      // No daemon, so no cache to clear — and the connection banner is already
      // on screen saying so.
      return;
    }
    void apis.agents
      .clearAgentCaches()
      .then(() => window.location.reload())
      .catch((err: unknown) => {
        void apis.diagnostics
          .recordUiLog({
            uiLogDto: {
              level: 'error',
              message: `clearing the agent cache failed: ${err instanceof Error ? err.message : String(err)}`,
              context: { kind: 'clear-agent-cache' },
            },
          })
          .catch(() => undefined);
      });
  }, [apis]);

  useEffect(
    () => window.geniro.onClearAgentCaches(clearAgentCaches),
    [clearAgentCaches],
  );

  // A quit asks every window to post the line measurements it still holds, before the daemon stops
  // (`main/line-measurement-flush.ts`). Answered here, in the always-mounted shell, so a window with
  // nothing to post answers at once rather than waiting out main's bound.
  useEffect(() => window.geniro.onFlushLineMeasurements(answerLineFlush), []);

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
    });
    clientRef.current = client;
    client.connect();
    setHandle(daemonHandle);
  }, []);

  const connectDaemon = useCallback(
    async (mode: 'read' | 'ensure' = 'read'): Promise<void> => {
      setReconnecting(true);
      try {
        // The banner's Retry ENSURES — asks main to start a daemon that died or
        // never came up. Reading the handle alone could only ever report that
        // there was none, so the button did nothing a second press could fix.
        // Mount still only reads: the launch's own start is in flight then, and
        // announces its handle through `onDaemonRestarted` when it lands.
        const daemonHandle =
          mode === 'ensure'
            ? await window.geniro.ensureDaemon()
            : await window.geniro.getDaemonHandle();
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
    },
    [attachDaemon],
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribeRestart = window.geniro.onDaemonRestarted(attachDaemon);
    void window.geniro.getStatus().then((status) => {
      if (cancelled) {
        return;
      }
      if (status.onboardingComplete) {
        setPhase('ready');
      } else {
        setPhase('onboarding');
      }
      void connectDaemon();
    });
    return () => {
      cancelled = true;
      unsubscribeRestart();
      clientRef.current?.close();
    };
  }, [attachDaemon, connectDaemon]);

  const handleOnboardingDone = useCallback(
    (destination?: FirstLaunch): void => {
      setGuideOpen(false);
      setPhase('ready');
      if (destination?.route === 'team' && destination.agent) {
        setTeamLaunch({ ...destination, agent: destination.agent });
        setView('workflows');
      } else if (destination?.route === 'chat' && destination.agent) {
        setThreadRequest(null);
        setChatLaunch(destination.agent);
        setView('chats');
      }
      if (!handle) {
        void connectDaemon();
      }
    },
    [connectDaemon, handle],
  );

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

  // ⌥⌘L opens the debug drawer, and since the title bar's trigger was removed
  // it is the only thing that does — which is the point rather than a gap: the
  // panel is a developer's answer to "what just happened", and it had been
  // occupying a slot in the one band every user sees. Settings' Diagnostics
  // section names the chord, so it is documented where somebody looking for it
  // would go.
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

  const { toggle: toggleTerminal } = terminals;
  useTerminalShortcut(
    useCallback(
      () => toggleTerminal(view === 'chats' ? chatFolder : null),
      [toggleTerminal, chatFolder, view],
    ),
  );

  /**
   * Keep the address bar naming the open view/thread. `history.replaceState`
   * rather than `location.hash =` or `pushState`: assigning the hash raises a
   * `hashchange` this same state would then read back as an incoming
   * navigation — a feedback loop — and `pushState` would put every thread a
   * click merely passed through onto the back stack.
   */
  const lastWrittenHashRef = useRef<string | null>(null);
  useEffect(() => {
    const hash = formatRoute(currentRoute(view, openRunId));
    if (hash !== window.location.hash) {
      // `history.state` is kept: it carries the phone back-entry marks
      // (`components/use-phone-back-entry.ts`).
      history.replaceState(history.state, '', hash);
    }
    lastWrittenHashRef.current = hash;
  }, [view, openRunId]);

  // A link pasted into this SAME already-open tab fires `hashchange` rather
  // than a reload, so this is what makes that act like a navigation. Guarded
  // against the write above by comparing against the hash THIS component
  // last wrote: `replaceState` does not itself raise `hashchange`, but the
  // comparison keeps this listener inert even if that ever stopped holding.
  useEffect(() => {
    const onHashChange = (): void => {
      const hash = window.location.hash;
      if (hash === lastWrittenHashRef.current) {
        return;
      }
      const route = parseRoute(hash);
      if (!route) {
        // Unrecognised — leave the app on whatever view it is already on
        // rather than blanking it.
        return;
      }
      setView(route.view);
      if (route.view === 'chats') {
        setThreadRequest(route.runId);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
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
        <CapabilitiesContext.Provider value={capabilities}>
          <Onboarding
            onDone={handleOnboardingDone}
            identities={agentIdentities}
          />
        </CapabilitiesContext.Provider>
      </>
    );
  }

  return (
    <CapabilitiesContext.Provider value={capabilities}>
      <AgentIdentityContext.Provider value={agentIdentities}>
        <div className="flex h-full flex-col">
          {/* ONE band across the window, above the columns — see `title-bar.tsx`
          for why it is not three rows in three columns any more. */}
          <TitleBar
            title={
              view !== 'chats'
                ? VIEW_TITLE[view]
                : narrowViewport && !chatsPhoneDetail
                  ? // The phone's chat LIST page names the place, like
                    // every other tab, rather than a chat nobody opened.
                    VIEW_TITLE.chats
                  : (chatTitle ?? 'New chat')
            }
            // The offer, resolved HERE from main's one state so the bar renders it
            // rather than deciding it — including `canInstall`, main's own answer
            // about this install (read-only volume, another account, a translocated
            // copy), so the control only appears where pressing it can work.
            //
            // NOTHING in a browser reached through the LAN gateway: install and
            // relaunch are both `denyRemotely` (they swap and restart the app on
            // the MAC), so a phone could only ever press a dead control — and on a
            // phone the bar's trailing edge belongs to the run-details opener,
            // which the version was drawn straight over.
            update={
              isRemoteRuntime()
                ? { kind: 'none' }
                : footerUpdate(update.state, updateEngaged)
            }
            onInstallUpdate={() => {
              setUpdateEngaged(true);
              void update.install();
            }}
            onRelaunchUpdate={() => void update.relaunch()}
            // Not on a phone, for the update control's reason: the bar's
            // trailing edge there belongs to the run-details opener, which
            // floats over it and would cover this glyph.
            usage={
              apis && !narrowViewport ? (
                <AppUsageButton
                  open={usageOpen}
                  onOpenChange={setUsageOpen}
                  data={appProcesses.data}
                  loading={appProcesses.loading}
                  error={appProcesses.error}
                  // Both writes, in this order, on `Tasks`' reason: the
                  // request is what `Chats` acts on.
                  onOpenThread={(runId) => {
                    setThreadRequest(runId);
                    setView('chats');
                  }}
                />
              ) : null
            }
          />
          <div className="flex min-h-0 flex-1">
            {/* The rail is the navigation at `sm` and wider; below it the
            bottom tab bar is. `flex` because NavRail carries no `h-full` of
            its own and stretches only as a flex row's child. */}
            <div className="flex max-sm:hidden">
              <NavRail
                view={view}
                onNavigate={setView}
                collapsed={sidebar.collapsed}
                hydrated={sidebar.hydrated}
                onToggleCollapsed={sidebar.toggle}
              />
            </div>
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
                  onRetry={() => void connectDaemon('ensure')}
                />
              )}
              {/* No update strip here. It and the nav rail's version row were two
            controls for one action in one window; the row is where the running
            version is already written, so that is the one that stayed. The
            connection banner above is NOT the same case and keeps its strip: a
            daemon that is not answering breaks the view under it, while an
            update is an offer with no deadline. */}
              {/* Chats stays mounted (hidden) across nav switches so its live WS room
            and active-run selection survive a trip to Settings/Workflows. */}
              <div
                className={cn('min-h-0 flex-1', view !== 'chats' && 'hidden')}>
                {handle && clientRef.current ? (
                  <Chats
                    client={clientRef.current}
                    handle={handle}
                    active={view === 'chats'}
                    firstLaunchAgent={chatLaunch}
                    onFirstLaunchHandled={() => setChatLaunch(null)}
                    onActiveRunChange={setOpenRunId}
                    onTitleChange={setChatTitle}
                    onOpenTerminal={terminals.openTab}
                    onFolderChange={setChatFolder}
                    // Chats has no route of its own to Settings — the nav rail is
                    // this component's. Handing it one callback is what lets the
                    // composer's "Manage fast actions" land ON the editor rather
                    // than on General with a hunt for it.
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setSettingsSectionOpen(true);
                      setView('settings');
                    }}
                    onPhoneDetailChange={setChatsPhoneDetail}
                    phoneHomeSignal={chatsHomeSignal}
                    openRunId={threadRequest}
                    onRunOpened={() => {
                      setThreadRequest(null);
                    }}
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
                <div
                  className={cn(
                    'min-h-0 flex-1',
                    view !== 'workflows' && 'hidden',
                  )}>
                  {workflowsMounted ? (
                    <Workflows
                      handle={handle}
                      client={clientRef.current}
                      active={view === 'workflows'}
                      firstLaunch={teamLaunch}
                      onFirstLaunchHandled={() => setTeamLaunch(null)}
                    />
                  ) : null}
                </div>
                <div
                  className={cn(
                    'min-h-0 flex-1',
                    view !== 'tasks' && 'hidden',
                  )}>
                  {tasksMounted ? (
                    <Tasks
                      handle={handle}
                      client={clientRef.current}
                      active={view === 'tasks'}
                      // Both writes, in this order: the request is what `Chats`
                      // acts on, and switching first would show the previous
                      // thread for a frame.
                      onOpenThread={(runId) => {
                        setThreadRequest(runId);
                        setView('chats');
                      }}
                    />
                  ) : null}
                </div>
                {/* Unmounted when hidden, like Settings and unlike Chats/Workflows:
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
                    <Settings
                      handle={handle}
                      onOpenOnboarding={
                        isRemoteRuntime() ? undefined : () => setGuideOpen(true)
                      }
                      section={settingsSection}
                      onSectionChange={setSettingsSection}
                      sectionOpen={settingsSectionOpen}
                      onSectionOpenChange={(open) => {
                        if (open) {
                          setSettingsSectionOpen(true);
                        } else {
                          settingsBack();
                        }
                      }}
                    />
                  </div>
                ) : null}
              </Suspense>
              {/* Above the debug drawer and, like it, below every view. */}
              <TerminalPanel
                terminals={terminals}
                onNewTab={() =>
                  terminals.openTab(
                    newTerminalFolder(
                      view === 'chats' ? chatFolder : null,
                      terminals,
                    ),
                  )
                }
              />
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
          {/* On every phone page: it is the phone's only navigation. */}
          <BottomTabBar
            view={view}
            onNavigate={(next) => {
              // Pressing the tab already on show goes back to its first
              // page, the way a phone's tab bar does.
              if (next === view && next === 'settings') {
                settingsBack();
              }
              if (next === view && next === 'chats') {
                setChatsHomeSignal((value) => value + 1);
              }
              setView(next);
            }}
          />
        </div>
        {guideOpen ? (
          <div className="fixed inset-0 z-50 bg-background">
            <WindowDragStrip />
            <Onboarding
              identities={agentIdentities}
              onDone={handleOnboardingDone}
              onClose={() => setGuideOpen(false)}
            />
          </div>
        ) : null}
      </AgentIdentityContext.Provider>
    </CapabilitiesContext.Provider>
  );
}
