import { createContext, useContext, useEffect } from 'react';

import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { OlderMessagesControl } from './older-messages-control';

/** Where loading one call conversation's rows stands. */
export interface CallConversationState {
  loading: boolean;
  /** The last read failed; it is asked again only on a press. */
  failed: boolean;
  /** The newest page loaded was full, so older rows may lie behind it. */
  hasOlder: boolean;
  /** The oldest row read so far; null before the first page lands. */
  oldestSeq: number | null;
}

/**
 * Loads a call card's own conversation, which a workflow run's window never
 * holds: the page of the run's own flow brings only what a folded card shows.
 */
export interface CallConversationLoader {
  /** The conversation's newest page, once — or, with `older`, the page before the oldest held. */
  load(conversation: string, older: boolean): void;
  /** Its pages from the newest back until `seq` is held; whether it now is. */
  loadThrough(conversation: string, seq: number): Promise<boolean>;
  /** Ask again for a conversation whose read failed. */
  retry(conversation: string): void;
  /** Null before the conversation was first asked for. */
  stateOf(conversation: string): CallConversationState | null;
}

/** Null on a surface whose transcript holds every row itself. */
export const CallConversationContext =
  createContext<CallConversationLoader | null>(null);

/**
 * Mounted inside an OPEN call card only — which is what makes opening the card
 * the moment its conversation is read.
 */
export function CallConversationPager({
  conversation,
}: {
  /** Any call of the conversation; the daemon reads the whole chain. */
  conversation: string;
}): React.JSX.Element | null {
  const loader = useContext(CallConversationContext);
  useEffect(() => {
    loader?.load(conversation, false);
  }, [loader, conversation]);
  const state = loader?.stateOf(conversation) ?? null;
  if (loader === null || state === null) {
    return null;
  }
  if (state.loading && !state.hasOlder) {
    return (
      <div
        role="status"
        data-slot="call-conversation-loading"
        className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner />
        Loading messages…
      </div>
    );
  }
  if (state.failed) {
    return (
      <div
        data-slot="call-conversation-failed"
        className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
        Couldn’t load this conversation.
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => loader.retry(conversation)}>
          Retry
        </Button>
      </div>
    );
  }
  if (!state.hasOlder) {
    return null;
  }
  return (
    <OlderMessagesControl
      slot="call-conversation-older"
      loading={state.loading}
      onLoad={() => loader.load(conversation, true)}
    />
  );
}
