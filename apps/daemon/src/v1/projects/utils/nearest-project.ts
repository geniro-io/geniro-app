import { dirname } from 'node:path';

/**
 * The project bound to `folder`, else the one whose folder holds it most
 * closely. The filesystem root and `homeDir` match only exactly: as an
 * ancestor, a project there would claim every chat on the machine. Among
 * projects sharing a folder the first listed wins.
 */
export function nearestProjectOf<T extends { folder: string }>(
  folder: string,
  projects: readonly T[],
  homeDir: string,
): T | null {
  const byFolder = new Map<string, T>();
  for (const project of projects) {
    if (!byFolder.has(project.folder)) {
      byFolder.set(project.folder, project);
    }
  }
  const exact = byFolder.get(folder);
  if (exact) {
    return exact;
  }
  for (let dir = dirname(folder); dir !== dirname(dir); dir = dirname(dir)) {
    const project = dir === homeDir ? undefined : byFolder.get(dir);
    if (project) {
      return project;
    }
  }
  return null;
}
