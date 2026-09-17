import type { TerminalExitEvent } from '../../shared/contracts';

export interface TerminalHandlers {
  data(data: string): void;
  exit(event: TerminalExitEvent): void;
}

const handlers = new Map<string, TerminalHandlers>();
let unsubscribe: (() => void) | null = null;

/**
 * Route one shell's output to its view.
 *
 * ONE pair of IPC listeners for every tab, dispatched by id, rather than a pair
 * per tab: each would run for every batch of every shell, and past ten tabs
 * Node warns about a leaking emitter.
 */
export function subscribeTerminal(
  id: string,
  terminal: TerminalHandlers,
): () => void {
  handlers.set(id, terminal);
  if (unsubscribe === null) {
    const offData = window.geniro.onTerminalData((event) =>
      handlers.get(event.id)?.data(event.data),
    );
    const offExit = window.geniro.onTerminalExit((event) =>
      handlers.get(event.id)?.exit(event),
    );
    unsubscribe = () => {
      offData();
      offExit();
    };
  }
  return () => {
    handlers.delete(id);
    if (handlers.size === 0 && unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
