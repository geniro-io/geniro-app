import type { AdapterConfig } from '../adapters/adapter.types';

/**
 * Whether a turn may be offered the monitor tools. Their command runs in no
 * sandbox of its own, so only where a geniro tool call is put to the user
 * first (`hostToolCallUngatedReason` null) or the turn is `auto`, whose own
 * shell is unsandboxed anyway. The one rule for chats and team nodes.
 */
export function offersMonitorTools(
  config: Pick<AdapterConfig, 'hostToolCallUngatedReason'>,
  mode: string | null | undefined,
): boolean {
  return mode === 'auto' || config.hostToolCallUngatedReason === null;
}
