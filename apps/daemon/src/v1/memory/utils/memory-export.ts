import type { MemoryEntry } from '../memory.types';

/**
 * The user's memory as one Markdown document: global entries first, then each
 * project's by name, every entry with its type, status, scope and source.
 */
export function memoryExportMarkdown(
  entries: readonly MemoryEntry[],
  projectNames: ReadonlyMap<string, string>,
  now: Date,
): string {
  const groups = new Map<string | null, MemoryEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.projectId) ?? [];
    group.push(entry);
    groups.set(entry.projectId, group);
  }
  const scopeOf = (projectId: string | null) =>
    projectId === null
      ? 'Global'
      : `Project: ${projectNames.get(projectId) ?? projectId}`;
  const order = [...groups.keys()].sort((a, b) =>
    a === null ? -1 : b === null ? 1 : scopeOf(a).localeCompare(scopeOf(b)),
  );
  const lines = [
    '# Geniro shared memory',
    '',
    `Exported ${now.toISOString()} · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`,
  ];
  for (const projectId of order) {
    const scope = scopeOf(projectId);
    lines.push('', `## ${scope}`);
    for (const entry of groups.get(projectId) ?? []) {
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
