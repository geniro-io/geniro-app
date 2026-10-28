import { HOST_MEMORY_TOOLS } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names one of the shared memory's tools.
 *
 * Auto-approved because a card per call would make memory unusable: an agent
 * searches it before most tasks. What makes that safe sits in
 * `MemoryService`, not in the approval: a write is held to the size cap, the
 * secret check and the near-duplicate check, lands `pending` while the user
 * reviews agent writes (when an agent may only add entries), and every entry
 * keeps who wrote it. A read sees only global entries and the run's own
 * project's.
 */
export function isHostMemoryCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return HOST_MEMORY_TOOLS.some((tool) =>
    isHostToolCall(serverName, toolName, tool),
  );
}
