import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ChatItem,
  ChatRun,
  CliKind,
  DaemonHandle,
} from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';
import { ChatApi } from '../chat-api';
import { DaemonClient } from '../daemon-client';

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
        <div className={`msg ${who}`}>
          <span className="msg-role">{who}</span>
          <div className="msg-text">{text}</div>
        </div>
      );
    }
    case 'reasoning':
      return (
        <div className="msg reasoning">
          <span className="msg-role">thinking</span>
          <div className="msg-text">
            {payloadString(item.payload, 'text') ?? ''}
          </div>
        </div>
      );
    case 'tool_call':
      return (
        <div className="msg tool">
          <span className="msg-role">
            🔧 {payloadString(item.payload, 'name') ?? 'tool'}
          </span>
          <pre className="msg-pre">
            {pretty(
              (item.payload as { input?: unknown } | null)?.input ?? null,
            )}
          </pre>
        </div>
      );
    case 'tool_result':
      return (
        <div className="msg tool">
          <span className="msg-role">⮑ result</span>
          <pre className="msg-pre">
            {pretty(
              (item.payload as { result?: unknown } | null)?.result ?? null,
            )}
          </pre>
        </div>
      );
    case 'error':
      return (
        <div className="msg error">
          <span className="msg-role">error</span>
          <div className="msg-text">
            {payloadString(item.payload, 'message') ?? 'unknown error'}
          </div>
        </div>
      );
    case 'turn_cancelled':
      return <div className="msg note">⊘ cancelled</div>;
    case 'turn_complete': {
      const usage = (item.payload as { usage?: unknown } | null)?.usage;
      const cost =
        usage && typeof usage === 'object' && 'costUsd' in usage
          ? (usage as { costUsd: unknown }).costUsd
          : null;
      return (
        <div className="msg note">
          ✓ done{typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}
        </div>
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
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
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
    void window.geniro
      .getSettings()
      .then((s) => setProjectFolder(s.projectFolder));
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

  const ensureRun = useCallback(async (): Promise<string | null> => {
    if (activeRunIdRef.current) {
      return activeRunIdRef.current;
    }
    if (!projectFolder) {
      setError('Pick a project folder in onboarding before starting a chat.');
      return null;
    }
    const run = await chatApi.createChat({ agentKind, cwd: projectFolder });
    setRuns((prev) => [run, ...prev]);
    await activateRun(run.id);
    return run.id;
  }, [agentKind, projectFolder, chatApi, activateRun]);

  const newChat = useCallback(async (): Promise<void> => {
    if (!projectFolder) {
      setError('Pick a project folder in onboarding before starting a chat.');
      return;
    }
    try {
      const run = await chatApi.createChat({ agentKind, cwd: projectFolder });
      setRuns((prev) => [run, ...prev]);
      await activateRun(run.id);
    } catch (err) {
      setError(String(err));
    }
  }, [agentKind, projectFolder, chatApi, activateRun]);

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
    <div className="chats">
      <aside className="chats-sidebar">
        <div className="chats-new">
          <select
            value={agentKind}
            onChange={(event) => setAgentKind(event.target.value as CliKind)}
            aria-label="Agent for new chat">
            {CLI_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => void newChat()}>
            New chat
          </button>
        </div>
        <ul className="chats-list">
          {runs.length === 0 ? (
            <li className="muted">No chats yet</li>
          ) : (
            runs.map((run) => (
              <li
                key={run.id}
                className={run.id === activeRunId ? 'active' : ''}
                role="button"
                tabIndex={0}
                aria-current={run.id === activeRunId ? true : undefined}
                onClick={() => void activateRun(run.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void activateRun(run.id);
                  }
                }}>
                <span className="chats-list-title">
                  {run.title ?? run.agentKind ?? 'chat'}
                </span>
                <span className="muted chats-list-meta">{run.status}</span>
              </li>
            ))
          )}
        </ul>
      </aside>

      <section className="chats-main">
        {projectFolder && (
          <div className="chats-cwd muted">cwd: {projectFolder}</div>
        )}
        {activeRun?.agentKind && (
          <div className="chats-agent-badge muted">
            agent: {activeRun.agentKind}
          </div>
        )}
        <div className="transcript">
          {activeRunId === null ? (
            <div className="center muted">
              Start a new chat or pick one to view its transcript.
            </div>
          ) : (
            items.map((item) => <TranscriptItem key={item.id} item={item} />)
          )}
          <div ref={transcriptEndRef} />
        </div>

        {error && <div className="chats-error">{error}</div>}

        <div className="composer">
          <textarea
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
            <button onClick={() => void cancel()}>Stop</button>
          ) : (
            <button
              className="primary"
              disabled={!input.trim()}
              onClick={() => void send()}>
              Send
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
