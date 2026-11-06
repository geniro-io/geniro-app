import { ThreadTitle } from './thread-message-card';
import { AgentName, PickedBackUpLine } from './wake-divider';

/**
 * A turn that a message from another thread woke, drawn as the agent picking
 * its work back up, with the thread that sent the message a press away.
 */
export function ThreadWakeDivider({
  caller,
  fromRunId,
  fromTitle,
}: {
  /** The woken agent's display name, or null where it has none. */
  caller: string | null;
  fromRunId: string;
  fromTitle: string;
}): React.JSX.Element {
  return (
    <PickedBackUpLine slot="thread-wake-divider">
      <AgentName name={caller} /> picked back up — a message from{' '}
      <ThreadTitle runId={fromRunId} title={fromTitle} />
    </PickedBackUpLine>
  );
}
