import {
  HOST_PLUGIN_TOOL,
  type HostPluginButton,
  type HostPluginOutcome,
  type HostPluginProposal,
} from '../chat.types';
import { instructionsDiff } from './host-project-instructions';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names `save_plugin`. Auto-approved because
 * the call writes nothing: its card showing the command is the gate.
 */
export function isHostPluginCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PLUGIN_TOOL);
}

/**
 * The card's `approval_request` input. The whole file text rides as
 * `new_string` (and the old one as `old_string`) so the card's
 * hidden-character scan reads every character Approve would write.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/plugin-proposal-card.tsx
 * `pluginCardOf` reads these keys.
 */
export function pluginCardInput(
  proposal: HostPluginProposal,
): Record<string, unknown> {
  return {
    summary: `${proposal.previousText === null ? 'Add' : 'Update'} plugin ${proposal.name}`,
    slug: proposal.slug,
    name: proposal.name,
    command: proposal.command,
    folders: proposal.folders,
    refreshMinutes: proposal.refreshMinutes,
    timeoutSeconds: proposal.timeoutSeconds,
    buttons: proposal.buttons,
    view: proposal.view,
    sample: proposal.sample,
    ...(proposal.previousText === null
      ? {}
      : {
          diff: instructionsDiff(proposal.previousText, proposal.text),
          old_string: proposal.previousText,
        }),
    new_string: proposal.text,
  };
}

/**
 * What the card's verdict row records of an Approve.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx `PermissionCard`
 * reads `outcome` and `answer` off the `approval_verdict` row.
 */
export function pluginVerdict(outcome: HostPluginOutcome): {
  outcome?: 'saved' | 'not-saved';
  answer?: string;
} {
  switch (outcome.status) {
    case 'saved':
      return { outcome: 'saved', answer: `saved as ${outcome.slug}` };
    case 'stale':
      return { outcome: 'not-saved', answer: outcome.reason };
    default:
      return {};
  }
}

/** What identifies a deferred plugin card, so an identical re-ask adopts it. */
export function pluginCardKey(proposal: HostPluginProposal): string {
  return `plugin:${JSON.stringify({
    slug: proposal.slug,
    text: proposal.text,
    baseHash: proposal.baseHash,
  })}`;
}

function isButton(value: unknown): value is HostPluginButton {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.command === 'string' &&
    typeof record.confirm === 'boolean'
  );
}

/** A stored proposal read back, or null for anything that does not read as one. */
export function readHostPluginProposal(
  raw: unknown,
): HostPluginProposal | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;
  if (
    typeof record.slug !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.text !== 'string' ||
    !(record.previousText === null || typeof record.previousText === 'string') ||
    !(record.baseHash === null || typeof record.baseHash === 'string') ||
    typeof record.command !== 'string' ||
    !Array.isArray(record.folders) ||
    !record.folders.every((folder) => typeof folder === 'string') ||
    !count(record.refreshMinutes) ||
    !count(record.timeoutSeconds) ||
    !Array.isArray(record.buttons) ||
    !record.buttons.every(isButton) ||
    !Array.isArray(record.view) ||
    !record.view.every(
      (component) => component !== null && typeof component === 'object',
    )
  ) {
    return null;
  }
  return {
    slug: record.slug,
    name: record.name,
    text: record.text,
    previousText: record.previousText,
    baseHash: record.baseHash,
    command: record.command,
    folders: record.folders as string[],
    refreshMinutes: record.refreshMinutes,
    timeoutSeconds: record.timeoutSeconds,
    buttons: record.buttons,
    view: record.view as Record<string, unknown>[],
    sample: record.sample ?? null,
  };
}

/** What the agent is told once the card is answered. */
export function hostPluginResultText(outcome: HostPluginOutcome): string {
  switch (outcome.status) {
    case 'saved':
      return `The user approved the plugin; it is saved as ${outcome.path} and its block shows in the right panel of chats in its folders. Do not write the file yourself.`;
    case 'declined':
      return 'The user rejected the plugin. Nothing was saved; ask what they would change.';
    case 'stale':
      return `The user approved the plugin but it could not be saved (${outcome.reason}). Nothing was written; tell the user, and propose it again on their word.`;
    case 'posted':
      return `The plugin is now on the user’s screen, waiting for them. STOP HERE and end your turn, and do not call this tool again for the same plugin. Their ${outcome.buttons ?? 'Approve or Reject'} arrives as your next user message.`;
    case 'unavailable':
      return `The plugin could not be put to the user (${outcome.reason}). Nothing was saved; describe it in your reply instead.`;
  }
}
