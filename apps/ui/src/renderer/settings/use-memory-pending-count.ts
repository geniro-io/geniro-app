import { useEffect, useState } from 'react';

import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';

/**
 * The shared memory's entries waiting for the user's review, read again on
 * every memory write and after a reconnect. Null until the first answer, and
 * again when a read fails, so a stale count is never drawn.
 */
export function useMemoryPendingCount(
  apis: DaemonApis | null,
  client: DaemonClient | null,
): number | null {
  const [pending, setPending] = useState<number | null>(null);
  const read = useLatestCallback(() => {
    void apis?.memories
      .memoryReviewSummary({})
      .then((summary) => setPending(summary.pending))
      .catch(() => setPending(null));
  }, [apis]);

  useEffect(() => {
    read();
    if (client === null) {
      return;
    }
    const offChanged = client.onMemoryChanged(read);
    const offConnected = client.onReconnect(read);
    return () => {
      offChanged();
      offConnected();
    };
  }, [apis, client, read]);

  return pending;
}
