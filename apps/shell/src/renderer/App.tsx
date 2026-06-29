import { useCallback, useEffect, useRef, useState } from 'react';

import { DaemonClient } from './daemon-client';
import { Onboarding } from './onboarding/Onboarding';

type Phase = 'loading' | 'onboarding' | 'ready';

interface HelloMessage {
  type: 'hello';
  version: string;
}

interface EchoMessage {
  type: 'echo';
  data: string;
}

function isHello(message: unknown): message is HelloMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'hello'
  );
}

function isEcho(message: unknown): message is EchoMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'echo'
  );
}

export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [connected, setConnected] = useState(false);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  const [lastEcho, setLastEcho] = useState<string | null>(null);
  const clientRef = useRef<DaemonClient | null>(null);

  const connectDaemon = useCallback(async (): Promise<void> => {
    const handle = await window.geniro.getDaemonHandle();
    if (!handle) {
      setConnected(false);
      return;
    }
    const client = new DaemonClient(handle, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (message) => {
        if (isHello(message)) {
          setDaemonVersion(message.version);
        } else if (isEcho(message)) {
          setLastEcho(message.data);
        }
      },
    });
    clientRef.current = client;
    client.connect();
  }, []);

  useEffect(() => {
    let cancelled = false;
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
      clientRef.current?.close();
    };
  }, [connectDaemon]);

  const handleOnboardingDone = useCallback((): void => {
    setPhase('ready');
    void connectDaemon();
  }, [connectDaemon]);

  if (phase === 'loading') {
    return <div className="center muted">Loading…</div>;
  }

  if (phase === 'onboarding') {
    return <Onboarding onDone={handleOnboardingDone} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">geniro</span>
        <span className={`status ${connected ? 'ok' : 'bad'}`}>
          {connected
            ? `● connected${daemonVersion ? ` · daemon v${daemonVersion}` : ''}`
            : '○ disconnected'}
        </span>
      </header>
      <main className="center">
        <h1>You&rsquo;re set up.</h1>
        <p className="muted">
          The daemon is running locally. Workflows and Chats arrive in the next
          milestones.
        </p>
        <button onClick={() => clientRef.current?.send('ping')}>
          Ping daemon
        </button>
        {lastEcho && <p className="muted">echo: {lastEcho}</p>}
      </main>
    </div>
  );
}
