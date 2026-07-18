import {
  ArrowUp,
  Clock,
  FolderOpen,
  ListPlus,
  Plus,
  Square,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import type {
  ChatItem,
  ChatRun,
  CliKind,
  DaemonHandle,
  TerminalSession,
  WorkflowAgentNode,
  WorkflowSummary,
  WorkflowTriggerNode,
} from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';
import { ChatApi } from '../chat-api';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../components/ui/utils';
import { DaemonClient } from '../daemon-client';
import { TerminalApi } from '../terminal-api';
import { WorkflowApi } from '../workflow-api';
import {
  type AgentDisplay,
  type AgentThread,
  CHAT_AGENT_KEY,
  computeAgentActivity,
  displayStatus,
  threadsOf,
} from './agent-activity';
import { AgentsPanel } from './agents-panel';
import { ApprovalCard } from './approval-card';
import { ChatHeader } from './chat-header';
import { ChatListItem } from './chat-list-item';
import { ComposerCard } from './composer-card';
import { RenameRunDialog } from './rename-run-dialog';
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

/**
 * Backoff for a queued send that hits RUN_BUSY. The run's terminal item is
 * persisted-then-emitted while the CLI process is still tearing down, so the
 * daemon frees the turn slot a beat AFTER the renderer learns the turn ended —
 * a queued auto-send racing into that gap is retried briefly, not failed.
 */
const QUEUED_BUSY_RETRIES_MS = [300, 600, 1200, 2400];

/** The trailing path segment of an absolute folder path (a compact label). */
function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * A run's sidebar label: its custom title when renamed, else the NAME of the
 * workflow it ran (falling back to the slug once the workflow is deleted),
 * else the agent driving the 1:1 chat.
 */
function runLabel(run: ChatRun, workflowNames: Map<string, string>): string {
  if (run.title) {
    return run.title;
  }
  if (run.workflowId) {
    return workflowNames.get(run.workflowId) ?? run.workflowId;
  }
  return run.agentKind ?? 'chat';
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
  // Recently used folders (persisted), surfaced as composer suggestion chips.
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the long-lived onItem subscription always filters against
  // the current run without re-subscribing.
  const activeRunIdRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  // Highest seq rendered for the active run — the replay cursor used to fetch
  // only the items missed during a disconnect.
  const lastSeqRef = useRef(-1);
  const reconnectAfterSeqRef = useRef(-1);
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

  // Messages written while the agent was still working — sent automatically,
  // one per settled turn, in order (Claude Code / Cursor-style queueing).
  // Keyed PER RUN and kept for the whole session: switching transcripts or
  // pages never loses a queue; reopening a run that settled meanwhile drains
  // it (activateRun fires the drain when the run is no longer working).
  const [queues, setQueues] = useState<Record<string, string[]>>({});
  const queuesRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    queuesRef.current = queues;
  }, [queues]);
  const enqueueMessage = useCallback((runId: string, text: string): void => {
    setQueues((prev) => ({
      ...prev,
      [runId]: [...(prev[runId] ?? []), text],
    }));
  }, []);
  // Ref indirection: the stable addItem callback fires the drain on a turn's
  // terminal item, but the drain itself needs the current chatApi closure.
  const drainQueueRef = useRef<(runId: string) => void>(() => {});
  // One drain at a time. A history REPLAY of a multi-turn transcript fires
  // the terminal-item trigger once per past turn in one synchronous sweep —
  // without this gate those calls all read the same stale queue head (the
  // ref syncs post-render) and double-send it.
  const drainingRef = useRef(false);

  const addItem = useCallback((item: ChatItem): void => {
    if (item.runId !== activeRunIdRef.current) {
      return;
    }
    setItems((prev) => {
      const last = prev[prev.length - 1];
      // Fast path: items carry a monotonic seq and are emitted persist-first,
      // so a strictly-newer item just appends. `items` stays seq-sorted, so a
      // full copy+resort per stream item (O(N² log N) to build a run) is only
      // needed on the rare out-of-order case below.
      if (last === undefined || item.seq > last.seq) {
        return [...prev, item];
      }
      // The replay/live seam (or a reconnect delta) can re-deliver or reorder a
      // seq: de-dupe by seq, then insert in seq order.
      if (prev.some((existing) => existing.seq === item.seq)) {
        return prev; // de-dupe the replay/live seam by seq
      }
      return [...prev, item].sort((a, b) => a.seq - b.seq);
    });
    if (item.seq > lastSeqRef.current) {
      lastSeqRef.current = item.seq;
    }
    // Mirror a streamed message into the sidebar row's preview + activity
    // time, so the list stays live without a refetch.
    if (item.kind === 'message') {
      const text = payloadString(item.payload, 'text');
      if (text !== null) {
        setRuns((prev) =>
          prev.map((run) =>
            run.id === item.runId
              ? { ...run, lastMessage: text, updatedAt: item.createdAt }
              : run,
          ),
        );
      }
    }
    // Only a RUN-level terminal item ends the working state — a workflow's
    // per-node turn_complete/error (nodeId set) must not re-enable the composer
    // while sibling branches are still running.
    if (TERMINAL_KINDS.has(item.kind) && item.nodeId === null) {
      sawTerminalRef.current = true;
      setStreaming(false);
      // Mirror the daemon's settle write into the sidebar list — without this
      // a finished run keeps its stale 'running' badge until an app restart.
      const settledStatus: ChatRun['status'] =
        item.kind === 'turn_complete'
          ? 'completed'
          : item.kind === 'turn_cancelled'
            ? 'cancelled'
            : 'failed';
      setRuns((prev) =>
        prev.map((run) =>
          run.id === item.runId
            ? { ...run, status: settledStatus, updatedAt: item.createdAt }
            : run,
        ),
      );
      // The turn ended — fire the next queued message into this chat (the
      // early return above guarantees item.runId IS the active run).
      if ((queuesRef.current[item.runId]?.length ?? 0) > 0) {
        drainQueueRef.current(item.runId);
      }
    }
  }, []);

  // The workflow library is editable on the Graphs page while this tab stays
  // mounted (hidden), so refetch it every time the tab becomes visible — a
  // mount-only fetch would leave the target selector stale after a save or
  // delete over there.
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
  useEffect(() => {
    if (!active) {
      return;
    }
    void workflowApi
      .list()
      .then((list) => {
        setWorkflows(list);
        setWorkflowsLoaded(true);
      })
      .catch(() => setWorkflows([]));
  }, [active, workflowApi]);

  // A remembered workflow target can be gone (deleted/renamed on the Graphs
  // page): once the library has ACTUALLY loaded, fall back instead of keeping
  // a dead selection. Gated on workflowsLoaded so the initial empty list (or
  // a failed fetch) never clobbers a target the restore just set.
  useEffect(() => {
    if (
      workflowsLoaded &&
      workflowSlug &&
      !workflows.some((wf) => wf.slug === workflowSlug)
    ) {
      setTarget('claude');
    }
  }, [workflowsLoaded, workflowSlug, workflows]);

  /** Composer target change — remembered as the default for next time. */
  const changeTarget = useCallback((value: string): void => {
    setTarget(value);
    void window.geniro.updateSettings({ lastChatTarget: value });
  }, []);

  // Sidebar labels show the workflow's NAME, not its slug.
  const workflowNames = useMemo(
    () => new Map(workflows.map((wf) => [wf.slug, wf.name])),
    [workflows],
  );

  // Relative "last activity" labels drift as time passes — re-render the list
  // once a minute while the tab is visible so "3m" doesn't freeze forever.
  const [, bumpClock] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = window.setInterval(bumpClock, 60_000);
    return () => window.clearInterval(id);
  }, [active]);

  // The run being renamed from the sidebar (null = dialog closed).
  const [renaming, setRenaming] = useState<ChatRun | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const openRename = useCallback((run: ChatRun): void => {
    setRenameError(null);
    setRenaming(run);
  }, []);
  const submitRename = useCallback(
    async (title: string): Promise<void> => {
      if (!renaming) {
        return;
      }
      setRenameBusy(true);
      setRenameError(null);
      try {
        const updated = await chatApi.rename(renaming.id, title);
        // Patch only the title — a concurrent WS item may have fresher
        // status/preview in state than this response's snapshot.
        setRuns((prev) =>
          prev.map((run) =>
            run.id === updated.id ? { ...run, title: updated.title } : run,
          ),
        );
        setRenaming(null);
      } catch (err) {
        setRenameError(String(err));
      } finally {
        setRenameBusy(false);
      }
    },
    [renaming, chatApi],
  );

  // The selected workflow's entry points for the composer's trigger select —
  // a run starts by firing a trigger, so the composer surfaces which one.
  const [triggers, setTriggers] = useState<
    { id: string; name: string; trigger: string }[]
  >([]);
  const [triggerId, setTriggerId] = useState('');
  useEffect(() => {
    if (!workflowSlug) {
      setTriggers([]);
      setTriggerId('');
      return;
    }
    let stale = false;
    workflowApi
      .get(workflowSlug)
      .then(({ workflow }) => {
        if (stale) {
          return;
        }
        const entries = workflow.nodes
          .filter(
            (node): node is WorkflowTriggerNode => node.kind === 'trigger',
          )
          .map((node) => ({
            id: node.id,
            name: node.name ?? node.id,
            trigger: node.trigger,
          }));
        setTriggers(entries);
        setTriggerId(entries[0]?.id ?? '');
      })
      .catch(() => {
        if (!stale) {
          setTriggers([]);
          setTriggerId('');
        }
      });
    return () => {
      stale = true;
    };
  }, [workflowSlug, workflowApi]);

  /** Reload the sidebar's run list from the daemon (statuses included) —
   *  live items only reach the ACTIVE run's room, so other runs' settles are
   *  picked up by refetching at natural moments (mount, pressing +). */
  const refreshRuns = useCallback((): void => {
    void Promise.all([chatApi.listChats(), workflowApi.listRuns()])
      .then(([chats, workflowRuns]) =>
        setRuns(
          [...chats, ...workflowRuns].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          ),
        ),
      )
      .catch((err: unknown) => setError(String(err)));
  }, [chatApi, workflowApi]);

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
      try {
        await client.joinRun(runId);
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
    void window.geniro.getSettings().then((s) => {
      setFolder(s.projectFolder);
      setRecentFolders(s.recentFolders ?? []);
      if (s.lastChatTarget) {
        setTarget(s.lastChatTarget);
      }
    });
    refreshRuns();
    const unsubscribeItem = client.onItem(addItem);
    const unsubscribeDisconnect = client.onDisconnect(() => {
      reconnectAfterSeqRef.current = lastSeqRef.current;
    });
    // On reconnect the WS missed any items streamed while offline (the room
    // buffers nothing for an absent member); fetch just the delta past the last
    // seq we rendered. addItem de-dupes, so an overlap with re-joined live items
    // is harmless.
    const unsubscribeReconnect = client.onReconnect((joinError) => {
      const active = activeRunIdRef.current;
      if (!active) {
        return;
      }
      if (joinError) {
        setError(joinError.message);
        return;
      }
      void chatApi
        .getHistory(active, reconnectAfterSeqRef.current)
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
    const selectedRun = activeRunIdRef.current;
    if (selectedRun) {
      void activateRun(selectedRun);
    }
    return () => {
      unsubscribeItem();
      unsubscribeDisconnect();
      unsubscribeReconnect();
      const active = activeRunIdRef.current;
      if (active) {
        client.leaveRun(active);
      }
    };
  }, [client, chatApi, addItem, activateRun, refreshRuns]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  // Persist a chosen folder as the last-used default for the next new chat,
  // and remember it among the recent-folder suggestions (most recent first).
  const chooseFolder = useCallback(
    (chosen: string): void => {
      setFolder(chosen);
      const next = [chosen, ...recentFolders.filter((f) => f !== chosen)].slice(
        0,
        5,
      );
      setRecentFolders(next);
      void window.geniro.updateSettings({
        projectFolder: chosen,
        recentFolders: next,
      });
    },
    [recentFolders],
  );

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

  /** The sidebar's + : back to the new-run composer. Nothing is created —
   *  the run (chat or workflow) is only seeded when the composer sends. */
  const newChat = useCallback((): void => {
    const previous = activeRunIdRef.current;
    if (previous) {
      client.leaveRun(previous);
    }
    activeRunIdRef.current = null;
    setActiveRunId(null);
    setItems([]);
    setStreaming(false);
    setError(null);
    refreshRuns();
  }, [client, refreshRuns]);

  /** The new-run composer's start: seed a fresh workflow run (fired from its
   *  trigger) or create a chat run and send its first message. */
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
      // The daemon flips the run to 'running' for the turn — mirror it in the
      // sidebar list (the terminal item flips it back on settle).
      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId ? { ...run, status: 'running' } : run,
        ),
      );
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

  /** Start one follow-up turn: mark the run working, send, render the user
   *  message (addItem de-dupes when the WS copy arrives). */
  const startTurn = useCallback(
    async (runId: string, text: string): Promise<void> => {
      setError(null);
      setStreaming(true);
      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId ? { ...run, status: 'running' } : run,
        ),
      );
      const userItem = await chatApi.sendMessage(runId, text);
      addItem(userItem);
    },
    [chatApi, addItem],
  );

  /** Send this run's next queued message after a settled turn (called via
   *  ref from the stable addItem callback, and from activateRun when a run
   *  that settled while away is reopened). One message per settled turn, in
   *  order; RUN_BUSY is retried per {@link QUEUED_BUSY_RETRIES_MS}. */
  const drainQueue = useCallback(
    async (runId: string): Promise<void> => {
      if (drainingRef.current) {
        return;
      }
      const next = (queuesRef.current[runId] ?? [])[0];
      if (next === undefined) {
        return;
      }
      drainingRef.current = true;
      setQueues((prev) => ({
        ...prev,
        [runId]: (prev[runId] ?? []).slice(1),
      }));
      const restoreHead = (): void =>
        setQueues((prev) => ({
          ...prev,
          [runId]: [next, ...(prev[runId] ?? [])],
        }));
      try {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await startTurn(runId, next);
            return;
          } catch (err) {
            const delay = QUEUED_BUSY_RETRIES_MS[attempt];
            if (!String(err).includes('RUN_BUSY') || delay === undefined) {
              // A real failure (no turn started, so no terminal item will
              // fire another drain) — keep the message at the queue head for
              // the user to edit or remove.
              setError(String(err));
              setStreaming(false);
              restoreHead();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            // The user switched transcripts mid-retry: never send into a run
            // they left. The message returns to that run's queue and goes
            // out when they come back to it.
            if (activeRunIdRef.current !== runId) {
              restoreHead();
              return;
            }
          }
        }
      } finally {
        drainingRef.current = false;
      }
    },
    [startTurn],
  );
  useEffect(() => {
    drainQueueRef.current = (runId) => void drainQueue(runId);
  }, [drainQueue]);

  /** The open transcript's composer: a follow-up into the ACTIVE chat run —
   *  never a run start (workflow runs take one task; their composer is off).
   *  While the agent is still working, the message QUEUES instead: it shows
   *  above the composer and sends automatically when the turn ends. */
  const sendFollowUp = useCallback(async (): Promise<void> => {
    const text = input.trim();
    const runId = activeRunIdRef.current;
    if (!text || !runId) {
      return;
    }
    if (streaming) {
      // Queueing is a chat-run concept — the workflow composer is disabled.
      if (runsRef.current.find((r) => r.id === runId)?.workflowId == null) {
        enqueueMessage(runId, text);
        setInput('');
      }
      return;
    }
    try {
      setInput('');
      await startTurn(runId, text);
    } catch (err) {
      setError(String(err));
      setStreaming(false);
    }
  }, [input, streaming, startTurn, enqueueMessage]);

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
    (item: ChatItem, allow: boolean, answer?: string): void => {
      const requestId = payloadString(item.payload, 'id');
      if (requestId) {
        client.sendVerdict(item.runId, requestId, allow, answer);
      }
    },
    [client],
  );

  // Requests the daemon reported as already settled — invalid answers remain
  // retryable, while expired cards stop retrying forever.
  const [deadRequestKeys, setDeadRequestKeys] = useState<Set<string>>(
    new Set(),
  );
  useEffect(
    () =>
      client.onVerdictAck((ack) => {
        if (
          ack.status === 'expired' &&
          ack.runId === activeRunIdRef.current &&
          ack.requestId
        ) {
          const requestKey = `${ack.runId}:${ack.requestId}`;
          setDeadRequestKeys((prev) => new Set(prev).add(requestKey));
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
  /** The open transcript's pending queue (queues persist per run). */
  const queued = activeRunId ? (queues[activeRunId] ?? []) : [];

  // The open PTY mirror. Session-scoped, NOT run-scoped: switching to another
  // run in the sidebar keeps the drawer open (the title names its session), so
  // a mirror can be watched while browsing other transcripts. Closing the
  // panel only detaches — the session keeps running and re-opens with a replay.
  const [terminal, setTerminal] = useState<{
    session: TerminalSession;
    title: string;
  } | null>(null);

  // The active workflow's node inventory: its agent nodes (the agents panel),
  // its triggers (the run composer's inactive info chips), and every node id
  // it knows (so trigger status items are never mistaken for an unknown
  // agent's).
  const [wfNodes, setWfNodes] = useState<{
    agents: WorkflowAgentNode[];
    triggers: WorkflowTriggerNode[];
    allIds: Set<string>;
  }>({ agents: [], triggers: [], allIds: new Set() });
  useEffect(() => {
    let cancelled = false;
    const workflowId = activeRun?.workflowId;
    if (!workflowId) {
      setWfNodes({ agents: [], triggers: [], allIds: new Set() });
      return;
    }
    void workflowApi
      .get(workflowId)
      .then(({ workflow }) => {
        if (cancelled) {
          return;
        }
        setWfNodes({
          agents: workflow.nodes.filter(
            (node): node is WorkflowAgentNode => node.kind === 'agent',
          ),
          triggers: workflow.nodes.filter(
            (node): node is WorkflowTriggerNode => node.kind === 'trigger',
          ),
          allIds: new Set(workflow.nodes.map((node) => node.id)),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setWfNodes({ agents: [], triggers: [], allIds: new Set() });
          setError(
            `Could not load workflow terminal targets: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.workflowId, workflowApi]);
  // Live per-agent state for the agents panel, derived purely from the
  // transcript (status items count parallel turns; call items list threads;
  // turn_complete usage carries context/spend).
  const activity = useMemo(() => computeAgentActivity(items), [items]);
  const [agentsPanelOpen, setAgentsPanelOpen] = useState(false);
  const toggleAgentsPanel = useCallback(
    () => setAgentsPanelOpen((open) => !open),
    [],
  );
  const agents = useMemo((): AgentDisplay[] => {
    if (!activeRun) {
      return [];
    }
    if (!activeRun.workflowId) {
      // A 1:1 chat has exactly one agent; its working state is the run's,
      // and its one thread IS the conversation.
      const chatActivity = activity.get(CHAT_AGENT_KEY);
      const running = streaming || activeRun.status === 'running';
      return [
        {
          id: CHAT_AGENT_KEY,
          name: activeRun.agentKind ?? 'agent',
          agent: activeRun.agentKind,
          status: running ? 'running' : activeRun.status,
          activeTurns: running ? 1 : 0,
          contextTokens: chatActivity?.contextTokens ?? null,
          spentUsd: chatActivity?.spentUsd ?? null,
          threads: [
            {
              id: 'main',
              kind: 'main',
              label: 'Conversation',
              status: running ? 'running' : activeRun.status,
              sessionId: null,
            },
          ],
        },
      ];
    }
    const known = wfNodes.agents.map((node): AgentDisplay => {
      const nodeActivity = activity.get(node.id);
      return {
        id: node.id,
        name: node.name ?? node.id,
        agent: node.agent,
        status: displayStatus(nodeActivity),
        activeTurns: nodeActivity?.activeTurns ?? 0,
        contextTokens: nodeActivity?.contextTokens ?? null,
        spentUsd: nodeActivity?.spentUsd ?? null,
        threads: threadsOf(nodeActivity),
      };
    });
    // Items can reference nodes a since-edited workflow no longer has — list
    // them too (unnamed) rather than hiding work that visibly happened.
    const extras = [...activity.entries()]
      .filter(
        ([nodeId]) => nodeId !== CHAT_AGENT_KEY && !wfNodes.allIds.has(nodeId),
      )
      .map(([nodeId, nodeActivity]): AgentDisplay => ({
        id: nodeId,
        name: nodeId,
        agent: null,
        status: displayStatus(nodeActivity),
        activeTurns: nodeActivity.activeTurns,
        contextTokens: nodeActivity.contextTokens,
        spentUsd: nodeActivity.spentUsd,
        threads: threadsOf(nodeActivity),
      }));
    return [...known, ...extras];
  }, [activeRun, activity, streaming, wfNodes]);

  /** Open a terminal mirroring ONE thread of one agent (the panel's action). */
  const openThreadTerminal = useCallback(
    async (agent: AgentDisplay, thread: AgentThread) => {
      const runId = activeRunIdRef.current;
      if (!runId) {
        return;
      }
      const nodeId = agent.id === CHAT_AGENT_KEY ? undefined : agent.id;
      try {
        setError(null);
        // Re-attach to a still-running mirror of this thread when one exists —
        // the daemon keeps detached sessions alive for exactly this. A call
        // thread matches by its recorded session id; the main thread matches
        // any mirror of the node that is NOT one of its call threads. The
        // daemon's createForRun is itself idempotent per target, so this
        // pre-check is an optimization (skip a create round-trip), not the
        // leak guard.
        const callSessionIds = new Set(
          agent.threads.flatMap((t) =>
            t.kind === 'call' && t.sessionId !== null ? [t.sessionId] : [],
          ),
        );
        const existing = (await terminalApi.list()).find(
          (s) =>
            s.runId === runId &&
            s.nodeId === (nodeId ?? null) &&
            s.status === 'running' &&
            (thread.sessionId !== null
              ? s.resumeSessionId === thread.sessionId
              : s.resumeSessionId === null ||
                !callSessionIds.has(s.resumeSessionId)),
        );
        const session =
          existing ??
          (await terminalApi.create({
            runId,
            ...(nodeId ? { nodeId } : {}),
            ...(thread.sessionId !== null
              ? { sessionId: thread.sessionId }
              : {}),
          }));
        const run = runsRef.current.find((r) => r.id === runId);
        const base =
          agent.id === CHAT_AGENT_KEY ? (run?.title ?? agent.name) : agent.name;
        setTerminal({
          session,
          title:
            thread.kind === 'call'
              ? `${base} · ${thread.id} — terminal`
              : `${base} — terminal`,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [terminalApi],
  );

  const showAgentsPanel = activeRunId !== null && agentsPanelOpen;

  // minmax(0,1fr): the transcript column must be allowed to shrink below its
  // content width, or a long cwd path widens the grid past the window. The
  // third `auto` column appears only while the agents panel is open (the
  // panel's own resizable width drives it).
  return (
    <div
      className={cn(
        'grid h-full',
        showAgentsPanel
          ? 'grid-cols-[260px_minmax(0,1fr)_auto]'
          : 'grid-cols-[260px_minmax(0,1fr)]',
      )}>
      <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center justify-between py-1.5 pr-2 pl-3">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Chats
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="New chat"
            title="New chat"
            onClick={newChat}>
            <Plus className="shrink-0" />
          </Button>
        </div>
        <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-3 pt-1">
          {runs.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No chats yet
            </li>
          ) : (
            runs.map((run) => (
              <ChatListItem
                key={run.id}
                active={run.id === activeRunId}
                label={runLabel(run, workflowNames)}
                isWorkflow={run.workflowId != null}
                status={run.status}
                lastMessage={run.lastMessage}
                lastActivityAt={run.updatedAt}
                onActivate={() => void activateRun(run.id)}
                onRename={() => openRename(run)}
              />
            ))
          )}
        </ul>
      </aside>

      {activeRunId === null ? (
        // The new-run composer — the landing view, one Cursor-style card: the
        // task text on top and, inside the same card, the graph/agent it
        // targets, the folder it runs in, and the trigger the run starts from
        // (a run only starts by firing one), with a round send control.
        <section className="flex min-h-0 flex-col items-center justify-center overflow-y-auto p-6">
          <div className="flex w-full max-w-2xl flex-col gap-5">
            <h2 className="text-center text-xl font-semibold tracking-tight">
              What are we building?
            </h2>
            <ComposerCard>
              <Textarea
                value={input}
                rows={4}
                aria-label="Task for the new run"
                className="min-h-24 rounded-2xl border-0 bg-transparent px-4 pt-3.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
                placeholder={
                  workflowSlug
                    ? 'Describe the task for the workflow team…'
                    : 'Message the agent…'
                }
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-1.5 p-2">
                <Select
                  value={target}
                  className="h-8 w-auto min-w-0 rounded-lg border-0 bg-transparent px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onChange={(event) => changeTarget(event.target.value)}
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
                  variant="ghost"
                  size="sm"
                  className="max-w-52 justify-start gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground"
                  title={folder ?? undefined}
                  aria-label="Choose the folder for new chats"
                  onClick={() => void pickFolder()}>
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {folder ? folderName(folder) : 'Choose folder…'}
                  </span>
                </Button>
                {workflowSlug && triggers.length > 0 ? (
                  <Select
                    value={triggerId}
                    className="h-8 w-auto min-w-0 rounded-lg border-0 bg-transparent px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    onChange={(event) => setTriggerId(event.target.value)}
                    aria-label="Trigger the run starts from">
                    {triggers.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {`${entry.name} · ${entry.trigger} trigger`}
                      </option>
                    ))}
                  </Select>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  className="ml-auto size-8 rounded-full"
                  disabled={!input.trim() || streaming}
                  aria-label={workflowSlug ? 'Start run' : 'Send'}
                  title={workflowSlug ? 'Start run' : 'Send'}
                  onClick={() => void send()}>
                  {workflowSlug ? (
                    <Zap className="size-4 shrink-0" />
                  ) : (
                    <ArrowUp className="size-4 shrink-0" />
                  )}
                </Button>
              </div>
            </ComposerCard>
            {/* Suggestion chips: recent folders + library workflows — one
                click fills the matching composer control. */}
            {recentFolders.some((f) => f !== folder) ||
            workflows.some((wf) => `wf:${wf.slug}` !== target) ? (
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {recentFolders
                  .filter((f) => f !== folder)
                  .slice(0, 3)
                  .map((f) => (
                    <Button
                      key={f}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 rounded-full px-3 text-xs font-normal text-muted-foreground"
                      title={f}
                      onClick={() => chooseFolder(f)}>
                      <FolderOpen className="size-3 shrink-0" />
                      <span className="max-w-40 truncate">{folderName(f)}</span>
                    </Button>
                  ))}
                {workflows
                  .filter((wf) => `wf:${wf.slug}` !== target)
                  .slice(0, 3)
                  .map((wf) => (
                    <Button
                      key={wf.slug}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 rounded-full px-3 text-xs font-normal text-muted-foreground"
                      title={`Run the ${wf.name} workflow`}
                      onClick={() => changeTarget(`wf:${wf.slug}`)}>
                      <WorkflowIcon className="size-3 shrink-0" />
                      <span className="max-w-40 truncate">{wf.name}</span>
                    </Button>
                  ))}
              </div>
            ) : null}
            {workflowSlug && triggers.length > 1 ? (
              <p className="text-center text-xs text-muted-foreground">
                This graph has {triggers.length} triggers — v1 fires them all on
                start.
              </p>
            ) : null}
            {error ? <ErrorText>{error}</ErrorText> : null}
          </div>
        </section>
      ) : (
        <section className="flex min-h-0 flex-col">
          {activeRun ? (
            <ChatHeader
              label={runLabel(activeRun, workflowNames)}
              isWorkflow={activeRun.workflowId != null}
              status={activeRun.status}
              lastActivityAt={activeRun.updatedAt}
              cwd={activeRun.cwd}
              sidePanelOpen={agentsPanelOpen}
              onToggleSidePanel={toggleAgentsPanel}
            />
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
            {items.map((item) => {
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
                    (expiredIds.has(requestId) ||
                      deadRequestKeys.has(`${item.runId}:${requestId}`))
                  }
                  onRespond={(allow, answer) =>
                    respondApproval(item, allow, answer)
                  }
                />
              );
            })}
            <div ref={transcriptEndRef} />
          </div>

          {error ? (
            <ErrorText className="border-t border-border px-4 py-2">
              {error}
            </ErrorText>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-border p-3">
            {queued.length > 0 ? (
              <div className="flex flex-col gap-1" aria-label="Queued messages">
                {queued.map((text, index) => (
                  <div
                    // Index keys are safe here: rows are removed by index and
                    // duplicate texts are legitimate queue entries.
                    key={`${index}-${text}`}
                    className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                    <Clock aria-hidden="true" className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={text}>
                      {text}
                    </span>
                    <span className="shrink-0">sends next</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5 shrink-0"
                      aria-label={`Remove queued message ${index + 1}`}
                      title="Remove from queue"
                      onClick={() =>
                        setQueues((prev) => ({
                          ...prev,
                          [activeRunId]: (prev[activeRunId] ?? []).filter(
                            (_, i) => i !== index,
                          ),
                        }))
                      }>
                      <X className="size-3 shrink-0" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            {/* The SAME composer card as the new-run screen, with the run's
                fixed choices (agent/graph, folder, trigger) as inactive
                chips — a run's identity can't change after creation. */}
            <ComposerCard>
              <Textarea
                value={input}
                rows={2}
                aria-label="Message the agent"
                disabled={activeRun?.workflowId != null}
                className="min-h-16 rounded-2xl border-0 bg-transparent px-4 pt-3.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
                placeholder={
                  activeRun?.workflowId
                    ? 'Workflow runs take one task — press + to start another.'
                    : streaming
                      ? 'Agent is working — your message will queue…'
                      : 'Message the agent…'
                }
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    void sendFollowUp();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-1.5 p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled
                  className="h-8 gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground">
                  {activeRun?.workflowId ? (
                    <>
                      <WorkflowIcon className="size-3.5 shrink-0" />
                      <span className="max-w-52 truncate">
                        {activeRun
                          ? runLabel(
                              { ...activeRun, title: null },
                              workflowNames,
                            )
                          : ''}
                      </span>
                    </>
                  ) : (
                    (activeRun?.agentKind ?? 'agent')
                  )}
                </Button>
                {activeRun?.cwd ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled
                    title={activeRun.cwd}
                    className="h-8 max-w-52 justify-start gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground">
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {folderName(activeRun.cwd)}
                    </span>
                  </Button>
                ) : null}
                {activeRun?.workflowId && wfNodes.triggers.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled
                    className="h-8 gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground">
                    <Zap className="size-3.5 shrink-0" />
                    <span className="max-w-52 truncate">
                      {`${wfNodes.triggers[0]!.name ?? wfNodes.triggers[0]!.id} · ${wfNodes.triggers[0]!.trigger} trigger`}
                    </span>
                  </Button>
                ) : null}
                <span className="ml-auto flex items-center gap-1.5">
                  {streaming ? (
                    <>
                      {input.trim() && activeRun?.workflowId == null ? (
                        <Button
                          type="button"
                          size="icon"
                          className="size-8 rounded-full"
                          aria-label="Queue"
                          title="Send automatically when the current turn ends"
                          onClick={() => void sendFollowUp()}>
                          <ListPlus className="size-4 shrink-0" />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-8 rounded-full"
                        aria-label="Stop"
                        title="Stop the current turn"
                        onClick={() => void cancel()}>
                        <Square className="size-3.5 shrink-0" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="icon"
                      className="size-8 rounded-full"
                      aria-label="Send"
                      title="Send"
                      disabled={!input.trim() || activeRun?.workflowId != null}
                      onClick={() => void sendFollowUp()}>
                      <ArrowUp className="size-4 shrink-0" />
                    </Button>
                  )}
                </span>
              </div>
            </ComposerCard>
          </div>
        </section>
      )}

      {showAgentsPanel ? (
        <AgentsPanel
          agents={agents}
          onOpenThread={(agent, thread) =>
            void openThreadTerminal(agent, thread)
          }
          onClose={() => setAgentsPanelOpen(false)}
        />
      ) : null}

      <RenameRunDialog
        open={renaming !== null}
        busy={renameBusy}
        error={renameError}
        initial={renaming ? runLabel(renaming, workflowNames) : ''}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => void submitRename(title)}
      />

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
          />
        </Suspense>
      ) : null}
    </div>
  );
}
