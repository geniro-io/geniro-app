import type { MemoryEntry } from '../memory.types';

const GLOBAL = 'global';

/**
 * The user's memory as one Markdown document: global entries first, then each
 * project's by name and each team's, every entry with its type, status, scope and source.
 */
export function memoryExportMarkdown(
  entries: readonly MemoryEntry[],
  projectNames: ReadonlyMap<string, string>,
  now: Date,
): string {
  const keyOf = (entry: MemoryEntry): string =>
    entry.teamSlug !== null
      ? `team:${entry.teamSlug}`
      : entry.projectId === null
        ? GLOBAL
        : `project:${entry.projectId}`;
  const headings = new Map<string, string>();
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    headings.set(
      key,
      entry.teamSlug !== null
        ? `Team: ${entry.teamSlug}`
        : entry.projectId === null
          ? 'Global'
          : `Project: ${projectNames.get(entry.projectId) ?? entry.projectId}`,
    );
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const headingOf = (key: string): string => headings.get(key) ?? key;
  const order = [...groups.keys()].sort((a, b) =>
    a === GLOBAL
      ? -1
      : b === GLOBAL
        ? 1
        : headingOf(a).localeCompare(headingOf(b)) || a.localeCompare(b),
  );
  const lines = [
    '# Geniro shared memory',
    '',
    `Exported ${now.toISOString()} · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`,
  ];
  for (const key of order) {
    const scope = headingOf(key);
    lines.push('', `## ${scope}`);
    for (const entry of groups.get(key) ?? []) {
      lines.push(
        '',
        `### ${entry.handle} · ${entry.title}`,
        '',
        `- Type: ${entry.type}`,
        `- Status: ${entry.status}`,
        `- Scope: ${scope}`,
        `- Source: ${sourceOf(entry)}`,
        `- Updated: ${entry.updatedAt}`,
        '',
        entry.body,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function sourceOf(entry: MemoryEntry): string {
  const { actor, agentKind, model, importedFrom } = entry.source;
  if (actor === 'import') {
    return importedFrom ? `imported from ${importedFrom}` : 'imported';
  }
  const who = [agentKind, model].filter(Boolean).join(' · ');
  return who ? `${actor} (${who})` : actor;
}
