/**
 * The open chat's composer placeholder. A phone gets the short form: its
 * field is 16px, and a placeholder longer than one line wraps under itself.
 */
export function followUpPlaceholder({
  archived,
  working,
  team,
  narrow,
}: {
  archived: boolean;
  working: boolean;
  team: boolean;
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
    return team
      ? 'The team is working — your message will queue…'
      : 'Agent is working — your message will queue…';
  }
  if (team) {
    return narrow
      ? 'Message the team…'
      : 'Message the team — it goes to the same trigger…';
  }
  return 'Message the agent…';
}
