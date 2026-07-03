import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonHandle } from '../shared/contracts';
import { Chats } from './chats/Chats';
import { EmptyState } from './components/empty-state';
import { Logo } from './components/logo';
import { StatusDot } from './components/status-dot';
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
    return <EmptyState>Loading…</EmptyState>;
  }

  if (phase === 'onboarding') {
    return <Onboarding onDone={handleOnboardingDone} />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 shadow-panel-sm">
        <Logo size="topbar" />
        <span className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <StatusDot tone={connected ? 'ok' : 'bad'} />
          {connected
            ? `connected${daemonVersion ? ` · daemon v${daemonVersion}` : ''}`
            : 'disconnected'}
        </span>
      </header>
      <main className="min-h-0 flex-1">
        {handle && clientRef.current ? (
          <Chats client={clientRef.current} handle={handle} />
        ) : (
          <EmptyState>Connecting to the daemon…</EmptyState>
        )}
      </main>
    </div>
  );
}
