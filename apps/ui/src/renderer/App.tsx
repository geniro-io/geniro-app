import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonHandle } from '../shared/contracts';
import { Chats } from './chats/Chats';
import { DaemonClient } from './daemon-client';
import { Onboarding } from './onboarding/Onboarding';

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
  const [connected, setConnected] = useState(false);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  const [handle, setHandle] = useState<DaemonHandle | null>(null);
  const clientRef = useRef<DaemonClient | null>(null);

  const connectDaemon = useCallback(async (): Promise<void> => {
    const daemonHandle = await window.geniro.getDaemonHandle();
    if (!daemonHandle) {
      setConnected(false);
      return;
    }
    const client = new DaemonClient(daemonHandle, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
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
    setHandle(daemonHandle); // triggers the render that mounts <Chats>
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
      <main className="app-body">
        {handle && clientRef.current ? (
          <Chats client={clientRef.current} handle={handle} />
        ) : (
          <div className="center muted">Connecting to the daemon…</div>
        )}
      </main>
    </div>
  );
}
