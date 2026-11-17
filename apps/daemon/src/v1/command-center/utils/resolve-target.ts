/** One roster thread a manager may name. */
export interface NameableThread {
  handle: string;
  runId: string;
  title: string;
}

export type TargetResolution =
  | { kind: 'resolved'; thread: NameableThread }
  | { kind: 'ambiguous'; candidates: NameableThread[] }
  | { kind: 'unknown'; candidates: NameableThread[] };

const CANDIDATES_MAX = 5;

function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * What a manager's name for a thread names on its roster: a handle (`t3`), a
 * run id, or a title matched exactly, case and spacing aside. A title two
 * roster threads share is ambiguous; a name matching nothing comes back with
 * the roster threads whose titles contain it, to ask the user with.
 */
export function resolveTarget(
  name: string,
  roster: readonly NameableThread[],
): TargetResolution {
  const wanted = folded(name);
  const byHandle = roster.find((thread) => folded(thread.handle) === wanted);
  if (byHandle !== undefined) {
    return { kind: 'resolved', thread: byHandle };
  }
  const byId = roster.find((thread) => thread.runId === name.trim());
  if (byId !== undefined) {
    return { kind: 'resolved', thread: byId };
  }
  const byTitle = roster.filter((thread) => folded(thread.title) === wanted);
  if (byTitle.length === 1 && byTitle[0] !== undefined) {
    return { kind: 'resolved', thread: byTitle[0] };
  }
  if (byTitle.length > 1) {
    return { kind: 'ambiguous', candidates: byTitle.slice(0, CANDIDATES_MAX) };
  }
  return {
    kind: 'unknown',
    candidates:
      wanted === ''
        ? []
        : roster
            .filter((thread) => folded(thread.title).includes(wanted))
            .slice(0, CANDIDATES_MAX),
  };
}
