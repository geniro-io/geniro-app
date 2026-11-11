import { useSyncExternalStore } from 'react';

/** The thread-UI-memory key under which a thread remembers its pane open. */
export const BROWSER_PANE_OPEN_KEY = 'browser:open';

const unseen = new Set<string>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An agent opened a tab in a chat whose pane the user has not looked at. */
export function markAgentTabUnseen(runId: string): void {
  if (!unseen.has(runId)) {
    unseen.add(runId);
    announce();
  }
}

export function clearAgentTabUnseen(runId: string): void {
  if (unseen.delete(runId)) {
    announce();
  }
}

export function useAgentTabUnseen(runId: string): boolean {
  return useSyncExternalStore(subscribe, () => unseen.has(runId));
}
