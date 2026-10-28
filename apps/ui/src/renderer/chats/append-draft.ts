/** Text put into a composer by a press: as is in an empty one, after a blank line otherwise. */
export function appendDraft(current: string, text: string): string {
  return current.trim() === '' ? text : `${current.trimEnd()}\n\n${text}`;
}
