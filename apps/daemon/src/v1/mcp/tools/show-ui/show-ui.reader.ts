import type { HostUiCall, HostUiOutcome } from '../../../agents/chat.types';

export function readHostUi(args: Record<string, unknown>): HostUiCall | null {
  const messages = args.messages;
  const present =
    (Array.isArray(messages) && messages.length > 0) ||
    (typeof messages === 'string' && messages.trim().length > 0);
  if (!present) {
    return null;
  }
  return {
    title: typeof args.title === 'string' ? args.title : null,
    messages,
  };
}

export function hostUiResultText(
  outcome: Exclude<HostUiOutcome, { status: 'invalid' }>,
): string {
  if (outcome.status === 'unavailable') {
    return `The card could not be shown (${outcome.reason}). Say it in your reply instead.`;
  }
  if (outcome.op === 'remove') {
    return `Removed: surface ${outcome.surfaceId}.`;
  }
  const media =
    outcome.media === 0
      ? ''
      : `, ${outcome.media} media ${outcome.media === 1 ? 'file' : 'files'} stored`;
  return `Shown: surface ${outcome.surfaceId} v${outcome.version} (${outcome.components} ${outcome.components === 1 ? 'component' : 'components'}${media}). Do not repeat its contents in your reply. A press reaches you as a user message.`;
}
