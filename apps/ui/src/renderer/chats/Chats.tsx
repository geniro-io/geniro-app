import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ChatItem,
  ChatRun,
  CliKind,
  DaemonHandle,
} from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';
import { ChatApi } from '../chat-api';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../components/ui/utils';
import { DaemonClient } from '../daemon-client';
import { MessageBubble } from './message-bubble';

/** Kinds that mark the end of a turn (re-enable the composer). */
const TERMINAL_KINDS = new Set<ChatItem['kind']>([
  'turn_complete',
  'turn_cancelled',
  'error',
]);

function payloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object' && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const PRE_CLASS = 'm-0 overflow-x-auto whitespace-pre-wrap font-mono text-xs';

/** The trailing path segment of an absolute folder path (a compact label). */
function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** One transcript row, rendered by item kind. */
function TranscriptItem({
  item,
}: {
  item: ChatItem;
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'message': {
      const text = payloadString(item.payload, 'text') ?? '';
      const who = item.role === 'user' ? 'user' : 'assistant';
      return (
        <MessageBubble variant={who} role={who}>
          <div className="whitespace-pre-wrap">{text}</div>
        </MessageBubble>
      );
    }
    case 'reasoning':
      return (
        <MessageBubble variant="reasoning" role="thinking">
          <div className="whitespace-pre-wrap italic">
            {payloadString(item.payload, 'text') ?? ''}
          </div>
        </MessageBubble>
      );
    case 'tool_call':
      return (
        <MessageBubble
          variant="tool"
          role={`🔧 ${payloadString(item.payload, 'name') ?? 'tool'}`}>
          <pre className={PRE_CLASS}>
            {pretty(
              (item.payload as { input?: unknown } | null)?.input ?? null,
            )}
          </pre>
        </MessageBubble>
      );
    case 'tool_result':
      return (
        <MessageBubble variant="tool" role="⮑ result">
          <pre className={PRE_CLASS}>
            {pretty(
              (item.payload as { result?: unknown } | null)?.result ?? null,
            )}
          </pre>
        </MessageBubble>
      );
    case 'error':
      return (
        <MessageBubble variant="error" role="error">
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'message') ?? 'unknown error'}
          </div>
        </MessageBubble>
      );
    case 'turn_cancelled':
      return <MessageBubble variant="note">⊘ cancelled</MessageBubble>;
    case 'turn_complete': {
      const usage = (item.payload as { usage?: unknown } | null)?.usage;
      const cost =
        usage && typeof usage === 'object' && 'costUsd' in usage
          ? (usage as { costUsd: unknown }).costUsd
          : null;
      return (
        <MessageBubble variant="note">
          ✓ done{typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}
        </MessageBubble>
      );
    }
    default:
      return null; // system / usage / attachment / status — not surfaced in M2
  }
}

export function Chats({
  client,
  handle,
}: {
  client: DaemonClient;
  handle: DaemonHandle;
}): React.JSX.Element {
  const chatApi = useMemo(() => new ChatApi(handle), [handle]);

  const [runs, setRuns] = useState<ChatRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [agentKind, setAgentKind] = useState<CliKind>('claude');
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
    if (TERMINAL_KINDS.has(item.kind)) {
      sawTerminalRef.current = true;
      setStreaming(false);
    }
  }, []);

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
          (!last || !TERMINAL_KINDS.has(last.kind))
        ) {
          setStreaming(true);
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [client, chatApi, addItem],
  );

  useEffect(() => {
    void window.geniro.getSettings().then((s) => setFolder(s.projectFolder));
    void chatApi
      .listChats()
      .then(setRuns)
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
        .catch((err: unknown) => setError(String(err)));
    });
    return () => {
      unsubscribeItem();
      unsubscribeReconnect();
      const active = activeRunIdRef.current;
      if (active) {
        client.leaveRun(active);
      }
    };
  }, [client, chatApi, addItem]);

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

  const ensureRun = useCallback(async (): Promise<string | null> => {
    if (activeRunIdRef.current) {
      return activeRunIdRef.current;
    }
    const cwd = await ensureFolder();
    if (!cwd) {
      setError('Choose a folder for this chat first.');
      return null;
    }
    const run = await chatApi.createChat({ agentKind, cwd });
    setRuns((prev) => [run, ...prev]);
    await activateRun(run.id);
    return run.id;
  }, [agentKind, ensureFolder, chatApi, activateRun]);

  const newChat = useCallback(async (): Promise<void> => {
    try {
      const cwd = await ensureFolder();
      if (!cwd) {
        return;
      }
      const run = await chatApi.createChat({ agentKind, cwd });
      setRuns((prev) => [run, ...prev]);
      await activateRun(run.id);
    } catch (err) {
      setError(String(err));
    }
  }, [agentKind, ensureFolder, chatApi, activateRun]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setError(null);
    try {
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
  }, [input, streaming, ensureRun, chatApi, addItem]);

  const cancel = useCallback(async (): Promise<void> => {
    const runId = activeRunIdRef.current;
    if (!runId) {
      return;
    }
    try {
      const { cancelled } = await chatApi.cancel(runId);
      // A live/claimed turn was cancelled → its terminal item arrives over WS and
      // clears the working state. `cancelled: false` means nothing was in flight
      // (the turn already finished), so clear it here rather than stay on Stop.
      if (!cancelled) {
        setStreaming(false);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [chatApi]);

  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;

  return (
    <div className="grid h-full grid-cols-[260px_1fr]">
      <aside className="flex min-h-0 flex-col gap-3 border-r border-border bg-sidebar p-3">
        <div className="flex flex-col gap-2">
          <Select
            value={agentKind}
            onChange={(event) => setAgentKind(event.target.value as CliKind)}
            aria-label="Agent for new chat">
            {CLI_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
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
            New chat
          </Button>
        </div>
        <ul className="flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
          {runs.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No chats yet
            </li>
          ) : (
            runs.map((run) => {
              const active = run.id === activeRunId;
              return (
                <li
                  key={run.id}
                  className={cn(
                    'flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50',
                    active &&
                      'bg-accent shadow-[inset_0_0_0_1px_var(--border)]',
                  )}
                  role="button"
                  tabIndex={0}
                  aria-current={active ? true : undefined}
                  onClick={() => void activateRun(run.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void activateRun(run.id);
                    }
                  }}>
                  <span className="truncate text-sm font-medium">
                    {run.title ?? run.agentKind ?? 'chat'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {run.status}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          {activeRun?.agentKind ? (
            <Badge variant="secondary">{activeRun.agentKind}</Badge>
          ) : null}
          {activeRun?.cwd ? (
            <span className="truncate text-xs text-muted-foreground">
              cwd: {activeRun.cwd}
            </span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
          {activeRunId === null ? (
            <EmptyState>
              Start a new chat or pick one to view its transcript.
            </EmptyState>
          ) : (
            items.map((item) => <TranscriptItem key={item.id} item={item} />)
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
            placeholder={streaming ? 'Agent is working…' : 'Message the agent…'}
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
              disabled={!input.trim()}
              onClick={() => void send()}>
              Send
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
