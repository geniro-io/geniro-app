/**
 * The open chat's composer placeholder. A phone gets the short form: its
 * field is 16px, and a placeholder longer than one line wraps under itself.
 */
export function followUpPlaceholder({
  archived,
  working,
  workflow,
  narrow,
}: {
  archived: boolean;
  working: boolean;
  workflow: boolean;
  narrow: boolean;
}): string {
  if (archived) {
    return narrow
      ? 'Archived — unarchive to continue'
      : 'This chat is archived — unarchive it to continue.';
  }
  if (working) {
    if (narrow) {
      return 'Working — your message will queue…';
    }
    return workflow
      ? 'The workflow is working — your message will queue…'
      : 'Agent is working — your message will queue…';
  }
  if (workflow) {
    return narrow
      ? 'Message the workflow…'
      : 'Message the workflow — it goes to the same trigger…';
  }
  return 'Message the agent…';
}
