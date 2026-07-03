import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonHandle } from '../shared/contracts';
import { Chats } from './chats/Chats';
import { EmptyState } from './components/empty-state';
import { type AppView, NavRail } from './components/nav-rail';
import { cn } from './components/ui/utils';
import { DaemonClient } from './daemon-client';
import { Graphs } from './graphs/Graphs';
import { Onboarding } from './onboarding/Onboarding';
import { Settings } from './settings/Settings';

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
    <div className="flex h-full">
      <NavRail
        view={view}
        onNavigate={setView}
        connected={connected}
        daemonVersion={daemonVersion}
      />
      <main className="min-h-0 flex-1">
        {/* Chats stays mounted (hidden) across nav switches so its live WS room
            and active-run selection survive a trip to Settings/Graphs. */}
        <div className={cn('h-full', view !== 'chats' && 'hidden')}>
          {handle && clientRef.current ? (
            <Chats client={clientRef.current} handle={handle} />
          ) : (
            <EmptyState>Connecting to the daemon…</EmptyState>
          )}
        </div>
        {view === 'graphs' ? <Graphs handle={handle} /> : null}
        {view === 'settings' ? <Settings /> : null}
      </main>
    </div>
  );
}
