import type { ClaudeModesCapability } from '../../chat.types';
import type {
  AgentApprovalMode,
  InstalledApprovalSupport,
} from '../adapter.types';

/**
 * The claude permission-mode probe's verdict, restated in the adapter-agnostic
 * shape {@link AgentAdapter.resolveApprovalMode} reads.
 *
 * The ONE translation point between this CLI's probe and the generic approval
 * contract, and the reason it is a pure function rather than a method on
 * `ClaudeProbeService`: callers pass the verdict they already resolved (the
 * graph executor awaits it once per run and threads it down), so a turn can
 * never end up judged against a verdict that landed after its run began.
 *
 * `unknown` maps to ABSENT, never to `false`. The distinction is the whole
 * point: an unprobed mode keeps what the caller asked for, so a genuine
 * rejection surfaces loudly from the CLI itself instead of being pre-empted by
 * a degrade nobody proved was needed.
 *
 * There is exactly one approval probe in the daemon and it is claude's, so
 * this bag is handed to whichever adapter runs a turn — an adapter reads only
 * the modes it declared in `probedApprovalModes`, and one that declared none
 * ignores it entirely.
 */
export function claudeApprovalSupport(
  capability: ClaudeModesCapability,
): InstalledApprovalSupport {
  const supported: Partial<Record<AgentApprovalMode, boolean>> = {};
  if (capability.acceptEdits !== 'unknown') {
    supported.acceptEdits = capability.acceptEdits === 'pass';
  }
  if (capability.plan !== 'unknown') {
    supported.plan = capability.plan === 'pass';
  }
  return { supported };
}
