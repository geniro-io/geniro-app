import { FolderOpen, Terminal as TerminalIcon } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  ChatItem,
  ChatRun,
  CliKind,
  DaemonHandle,
  TerminalSession,
  WorkflowSummary,
} from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';
import { ChatApi } from '../chat-api';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { NavListItem } from '../components/nav-list-item';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { DaemonClient } from '../daemon-client';
import { TerminalApi } from '../terminal-api';
import { WorkflowApi } from '../workflow-api';
import { ApprovalCard } from './approval-card';
import {
  collectVerdicts,
  expiredApprovalIds,
  payloadString,
  TranscriptItem,
} from './transcript-item';

// Code-split the terminal mirror: xterm.js (~250KB) must not ride the startup
// chunk of the always-mounted Chats tab for a panel most sessions never open.
const TerminalPanel = lazy(() =>
  import('../terminals/terminal-panel').then((m) => ({
    default: m.TerminalPanel,
  })),
);

/** Kinds that mark the end of a turn (re-enable the composer). */
const TERMINAL_KINDS = new Set<ChatItem['kind']>([
  'turn_complete',
  'turn_cancelled',
  'error',
]);

/** The trailing path segment of an absolute folder path (a compact label). */
function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export function Chats({
  client,
  handle,
  active = true,
}: {
  client: DaemonClient;
  handle: DaemonHandle;
  /** False while another view is shown (the tab stays mounted, hidden). */
  active?: boolean;
}): React.JSX.Element {
  const chatApi = useMemo(() => new ChatApi(handle), [handle]);
  const workflowApi = useMemo(() => new WorkflowApi(handle), [handle]);
  const terminalApi = useMemo(() => new TerminalApi(handle), [handle]);

  const [runs, setRuns] = useState<ChatRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  // What the composer targets: a bare CLI kind for a single-agent chat, or
  // `wf:<slug>` to run a library workflow as a team.
  const [target, setTarget] = useState<string>('claude');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const workflowSlug = target.startsWith('wf:') ? target.slice(3) : null;
  const agentKind = (workflowSlug ? 'claude' : target) as CliKind;
  // Working directory for the NEXT new chat. Seeded from the last-used folder
  // (persisted in settings); each chat records its own cwd, so this is only the
  // default the picker starts from.
  const [folder, setFolder] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the long-lived onItem subscription always filters against
  // the current run without re-subscribing.
  const activeRunIdRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  // Highest seq rendered for the active run — the replay cursor used to fetch
  // only the items missed during a disconnect.
  const lastSeqRef = useRef(-1);
  // Mirror `runs` into a ref so the stable activateRun callback can read the
  // active run's current status without being re-created on every list change.
  const runsRef = useRef<ChatRun[]>([]);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);
  // True once a terminal item has been seen for the active run since the last
  // activateRun. Guards the post-replay streaming derive from re-arming Stop on a
  // turn that already ended — e.g. a terminal WS item that lands during the
  // history fetch while the cached run.status is still 'running' and the history
  // snapshot predates that terminal item.
  const sawTerminalRef = useRef(false);

  const addItem = useCallback((item: ChatItem): void => {
    if (item.runId !== activeRunIdRef.current) {
      return;
    }
    setItems((prev) => {
      if (prev.some((existing) => existing.seq === item.seq)) {
        return prev; // de-dupe the replay/live seam by seq
      }
      return [...prev, item].sort((a, b) => a.seq - b.seq);
    });
    if (item.seq > lastSeqRef.current) {
      lastSeqRef.current = item.seq;
    }
    // Only a RUN-level terminal item ends the working state — a workflow's
    // per-node turn_complete/error (nodeId set) must not re-enable the composer
    // while sibling branches are still running.
    if (TERMINAL_KINDS.has(item.kind) && item.nodeId === null) {
      sawTerminalRef.current = true;
      setStreaming(false);
    }
  }, []);

  // The workflow library is editable on the Graphs page while this tab stays
  // mounted (hidden), so refetch it every time the tab becomes visible — a
  // mount-only fetch would leave the target selector stale after a save or
  // delete over there.
  useEffect(() => {
    if (!active) {
      return;
    }
    void workflowApi
      .list()
      .then(setWorkflows)
      .catch(() => setWorkflows([]));
  }, [active, workflowApi]);

  const activateRun = useCallback(
    async (runId: string): Promise<void> => {
      const previous = activeRunIdRef.current;
      if (previous && previous !== runId) {
        client.leaveRun(previous);
      }
      activeRunIdRef.current = runId;
      lastSeqRef.current = -1;
      sawTerminalRef.current = false;
      setActiveRunId(runId);
      setItems([]);
      setStreaming(false);
      setError(null);
      // Join FIRST so any live item published during the history fetch is
      // buffered through addItem; the seq de-dupe reconciles the overlap.
      client.joinRun(runId);
      try {
        const history = await chatApi.getHistory(runId);
        // The user may have switched runs while this fetch was in flight —
        // a stale completion must not replay items or re-arm Stop/streaming
        // (and cross-contaminate errors) for the CURRENTLY active run.
        if (activeRunIdRef.current !== runId) {
          return;
        }
        history.forEach(addItem);
        // Reconnecting/switching to an in-flight run must show the working state
        // (Stop), not an enabled Send that a second message would race into a
        // RUN_BUSY. Derive it from the run's status + whether the replayed
        // transcript already ended on a terminal item.
        const run = runsRef.current.find((r) => r.id === runId);
        const last = history.at(-1);
        if (
          run?.status === 'running' &&
          !sawTerminalRef.current &&
          (!last || !(TERMINAL_KINDS.has(last.kind) && last.nodeId === null))
        ) {
          setStreaming(true);
        }
      } catch (err) {
        if (activeRunIdRef.current === runId) {
          setError(String(err));
        }
      }
    },
    [client, chatApi, addItem],
  );

  useEffect(() => {
    void window.geniro.getSettings().then((s) => setFolder(s.projectFolder));
    void Promise.all([chatApi.listChats(), workflowApi.listRuns()])
      .then(([chats, workflowRuns]) =>
        setRuns(
          [...chats, ...workflowRuns].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          ),
        ),
      )
      .catch((err: unknown) => setError(String(err)));
    const unsubscribeItem = client.onItem(addItem);
    // On reconnect the WS missed any items streamed while offline (the room
    // buffers nothing for an absent member); fetch just the delta past the last
    // seq we rendered. addItem de-dupes, so an overlap with re-joined live items
    // is harmless.
    const unsubscribeReconnect = client.onReconnect(() => {
      const active = activeRunIdRef.current;
      if (!active) {
        return;
      }
      void chatApi
        .getHistory(active, lastSeqRef.current)
        .then((items) => items.forEach(addItem))
        // Same stale-run guard as activateRun's catch: if the user switched
        // runs while this delta-fetch was in flight, A's error must not paint
        // over B (addItem is already run-scoped by item.runId; setError is not).
        .catch((err: unknown) => {
          if (activeRunIdRef.current === active) {
            setError(String(err));
          }
        });
    });
    return () => {
      unsubscribeItem();
      unsubscribeReconnect();
      const active = activeRunIdRef.current;
      if (active) {
        client.leaveRun(active);
      }
    };
  }, [client, chatApi, workflowApi, addItem]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  // Persist a chosen folder as the last-used default for the next new chat.
  const chooseFolder = useCallback((chosen: string): void => {
    setFolder(chosen);
    void window.geniro.updateSettings({ projectFolder: chosen });
  }, []);

  const pickFolder = useCallback(async (): Promise<void> => {
    const chosen = await window.geniro.pickProjectFolder();
    if (chosen) {
      chooseFolder(chosen);
    }
  }, [chooseFolder]);

  // Resolve the working directory for a new chat: reuse the default, else
  // prompt. Returns null when the user cancels the picker.
  const ensureFolder = useCallback(async (): Promise<string | null> => {
    if (folder) {
      return folder;
    }
    const chosen = await window.geniro.pickProjectFolder();
    if (chosen) {
      chooseFolder(chosen);
    }
    return chosen;
  }, [folder, chooseFolder]);

  const createChatRun = useCallback(
    async (cwd: string) => chatApi.createChat({ agentKind, cwd }),
    [agentKind, chatApi],
  );

  const ensureRun = useCallback(async (): Promise<string | null> => {
    if (activeRunIdRef.current) {
      return activeRunIdRef.current;
    }
    const cwd = await ensureFolder();
    if (!cwd) {
      setError('Choose a folder for this chat first.');
      return null;
    }
    const run = await createChatRun(cwd);
    setRuns((prev) => [run, ...prev]);
    await activateRun(run.id);
    return run.id;
  }, [ensureFolder, createChatRun, activateRun]);

  const newChat = useCallback(async (): Promise<void> => {
    try {
      if (workflowSlug) {
        // A workflow run takes one task prompt: deselect so the composer
        // seeds a fresh run on Send.
        const previous = activeRunIdRef.current;
        if (previous) {
          client.leaveRun(previous);
        }
        activeRunIdRef.current = null;
        setActiveRunId(null);
        setItems([]);
        setStreaming(false);
        setError(null);
        return;
      }
      const cwd = await ensureFolder();
      if (!cwd) {
        return;
      }
      const run = await createChatRun(cwd);
      setRuns((prev) => [run, ...prev]);
      await activateRun(run.id);
    } catch (err) {
      setError(String(err));
    }
  }, [workflowSlug, client, ensureFolder, createChatRun, activateRun]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setError(null);
    try {
      // A workflow target ALWAYS seeds a fresh run — never routes the task
      // into whatever run happens to be open (activateRun leaves the old room).
      if (workflowSlug) {
        const cwd = await ensureFolder();
        if (!cwd) {
          setError('Choose a folder for this run first.');
          return;
        }
        setInput('');
        const run = await workflowApi.run(workflowSlug, { cwd, prompt: text });
        setRuns((prev) => [run, ...prev]);
        await activateRun(run.id);
        // A run can fail-fast within the activation window (missing CLI →
        // instant terminal item in the replayed history); re-arming Stop then
        // would wedge the composer on a run that will emit nothing more.
        if (!sawTerminalRef.current) {
          setStreaming(true);
        }
        return;
      }
      const runId = await ensureRun();
      if (!runId) {
        return;
      }
      setInput('');
      setStreaming(true);
      // Render the user message even if join raced the publish; addItem de-dupes
      // when the WS copy arrives.
      const userItem = await chatApi.sendMessage(runId, text);
      addItem(userItem);
    } catch (err) {
      setError(String(err));
      setStreaming(false);
    }
  }, [
    input,
    streaming,
    workflowSlug,
    workflowApi,
    ensureFolder,
    activateRun,
    ensureRun,
    chatApi,
    addItem,
  ]);

  const cancel = useCallback(async (): Promise<void> => {
    const runId = activeRunIdRef.current;
    if (!runId) {
      return;
    }
    try {
      const activeIsWorkflow =
        runsRef.current.find((r) => r.id === runId)?.workflowId != null;
      const { cancelled } = activeIsWorkflow
        ? await workflowApi.cancelRun(runId)
        : await chatApi.cancel(runId);
      // A live/claimed turn was cancelled → its terminal item arrives over WS and
      // clears the working state. `cancelled: false` means nothing was in flight
      // (the turn already finished), so clear it here rather than stay on Stop.
      if (!cancelled) {
        setStreaming(false);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [chatApi, workflowApi]);

  const respondApproval = useCallback(
    (item: ChatItem, allow: boolean): void => {
      const requestId = payloadString(item.payload, 'id');
      if (requestId) {
        client.sendVerdict(item.runId, requestId, allow);
      }
    },
    [client],
  );

  // Requests the daemon reported as already settled (`verdict_ack` with
  // applied: false) — the card renders expired instead of retrying forever.
  const [deadRequestIds, setDeadRequestIds] = useState<Set<string>>(new Set());
  useEffect(
    () =>
      client.onVerdictAck((ack) => {
        if (!ack.applied && ack.requestId) {
          const requestId = ack.requestId;
          setDeadRequestIds((prev) => new Set(prev).add(requestId));
        }
      }),
    [client],
  );

  const verdicts = useMemo(() => collectVerdicts(items), [items]);
  const expiredIds = useMemo(
    () => expiredApprovalIds(items, verdicts),
    [items, verdicts],
  );

  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;

  // The open PTY mirror. Session-scoped, NOT run-scoped: switching to another
  // run in the sidebar keeps the drawer open (the title names its session), so
  // a mirror can be watched while browsing other transcripts. Closing the
  // panel only detaches — the session keeps running and re-opens with a replay.
  const [terminal, setTerminal] = useState<{
    session: TerminalSession;
    title: string;
  } | null>(null);

  /** Node ids seen in this run's transcript — the workflow "open terminal" targets. */
  const runNodeIds = useMemo(
    () => [
      ...new Set(items.flatMap((item) => (item.nodeId ? [item.nodeId] : []))),
    ],
    [items],
  );

  const openTerminal = useCallback(
    async (runId: string, nodeId?: string) => {
      try {
        setError(null);
        // Re-attach to a still-running session for this (run, node) when one
        // exists — the daemon keeps detached sessions alive for exactly this.
        // The daemon's createForRun is itself idempotent per (run, node), so
        // this pre-check is an optimization (skip a create round-trip), not
        // the leak guard.
        const existing = (await terminalApi.list()).find(
          (s) =>
            s.runId === runId &&
            s.nodeId === (nodeId ?? null) &&
            s.status === 'running',
        );
        const session =
          existing ??
          (await terminalApi.create(nodeId ? { runId, nodeId } : { runId }));
        const run = runs.find((r) => r.id === runId);
        setTerminal({
          session,
          title: nodeId
            ? `${nodeId} — terminal`
            : `${run?.title ?? run?.agentKind ?? 'agent'} — terminal`,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [terminalApi, runs],
  );

  const endTerminalSession = useCallback(() => {
    if (!terminal) {
      return;
    }
    const id = terminal.session.id;
    setTerminal(null);
    terminalApi.dispose(id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // A 404 means the daemon already reaped the session — nothing to end.
      // Anything else (daemon restart, transient failure) must surface: the
      // panel is already closed, but the REPL may still be running.
      if (!message.includes('(404)')) {
        setError(message);
      }
    });
  }, [terminal, terminalApi]);

  // minmax(0,1fr): the transcript column must be allowed to shrink below its
  // content width, or a long cwd path widens the grid past the window.
  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-3 border-r border-border bg-sidebar p-3">
        <div className="flex flex-col gap-2">
          <Select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            aria-label="Agent or workflow for new runs">
            <optgroup label="Agents">
              {CLI_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </optgroup>
            {workflows.length > 0 ? (
              <optgroup label="Workflows">
                {workflows.map((wf) => (
                  <option key={wf.slug} value={`wf:${wf.slug}`}>
                    {wf.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
          <Button
            type="button"
            variant="outline"
            className="justify-start gap-2 font-normal"
            title={folder ?? undefined}
            aria-label="Choose the folder for new chats"
            onClick={() => void pickFolder()}>
            <FolderOpen className="shrink-0" />
            <span className="truncate">
              {folder ? folderName(folder) : 'Choose folder…'}
            </span>
          </Button>
          <Button type="button" onClick={() => void newChat()}>
            {workflowSlug ? 'New run' : 'New chat'}
          </Button>
        </div>
        <ul className="flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
          {runs.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No chats yet
            </li>
          ) : (
            runs.map((run) => (
              <NavListItem
                key={run.id}
                active={run.id === activeRunId}
                title={run.title ?? run.agentKind ?? 'chat'}
                subtitle={
                  run.workflowId ? `workflow · ${run.status}` : run.status
                }
                onActivate={() => void activateRun(run.id)}
              />
            ))
          )}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          {activeRun?.workflowId ? (
            <Badge variant="secondary">workflow: {activeRun.workflowId}</Badge>
          ) : activeRun?.agentKind ? (
            <Badge variant="secondary">{activeRun.agentKind}</Badge>
          ) : null}
          {activeRun?.cwd ? (
            <span className="max-w-full min-w-0 truncate text-xs text-muted-foreground">
              cwd: {activeRun.cwd}
            </span>
          ) : null}
          {/* Cursor's subscription TUI is deferred, so only claude gets a mirror. */}
          {activeRun &&
          !activeRun.workflowId &&
          activeRun.agentKind === 'claude' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto gap-1.5"
              onClick={() => void openTerminal(activeRun.id)}>
              <TerminalIcon className="size-3.5 shrink-0" />
              Terminal
            </Button>
          ) : null}
          {activeRun?.workflowId && runNodeIds.length > 0 ? (
            <span className="ml-auto flex flex-wrap gap-1">
              {runNodeIds.map((nodeId) => (
                <Button
                  key={nodeId}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  title={`Open a terminal mirroring ${nodeId}`}
                  onClick={() => void openTerminal(activeRun.id, nodeId)}>
                  <TerminalIcon className="size-3.5 shrink-0" />
                  {nodeId}
                </Button>
              ))}
            </span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
          {activeRunId === null ? (
            <EmptyState>
              Start a new chat or pick one to view its transcript.
            </EmptyState>
          ) : (
            items.map((item) => {
              if (item.kind !== 'approval_request') {
                return <TranscriptItem key={item.id} item={item} />;
              }
              const requestId = payloadString(item.payload, 'id');
              return (
                <ApprovalCard
                  key={item.id}
                  toolName={payloadString(item.payload, 'toolName') ?? 'tool'}
                  input={
                    (item.payload as { input?: unknown } | null)?.input ?? null
                  }
                  verdict={requestId ? (verdicts.get(requestId) ?? null) : null}
                  expired={
                    requestId !== null &&
                    (expiredIds.has(requestId) || deadRequestIds.has(requestId))
                  }
                  onRespond={(allow) => respondApproval(item, allow)}
                />
              );
            })
          )}
          <div ref={transcriptEndRef} />
        </div>

        {error ? (
          <ErrorText className="border-t border-border px-4 py-2">
            {error}
          </ErrorText>
        ) : null}

        <div className="flex items-end gap-2 border-t border-border p-3">
          <Textarea
            value={input}
            aria-label="Message the agent"
            disabled={activeRun?.workflowId != null && !workflowSlug}
            placeholder={
              workflowSlug
                ? 'Describe the task for the workflow team (starts a new run)…'
                : activeRun?.workflowId
                  ? 'Workflow runs take one task — pick a workflow or an agent to start another.'
                  : streaming
                    ? 'Agent is working…'
                    : 'Message the agent…'
            }
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {streaming ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancel()}>
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              disabled={
                !input.trim() ||
                (activeRun?.workflowId != null && !workflowSlug)
              }
              onClick={() => void send()}>
              Send
            </Button>
          )}
        </div>
      </section>

      {/* Render only while this tab is visible — the panel is fixed-position
          and would otherwise overlay Graphs/Settings from the hidden tab. */}
      {active && terminal ? (
        <Suspense fallback={null}>
          <TerminalPanel
            key={terminal.session.id}
            handle={handle}
            session={terminal.session}
            title={terminal.title}
            onClose={() => setTerminal(null)}
            onEndSession={endTerminalSession}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
