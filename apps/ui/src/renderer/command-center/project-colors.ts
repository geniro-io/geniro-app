import { PROFILE_COLORS, type ProfileColor } from '../../shared/contracts';

export interface ProjectColor {
  id: string;
  name: string;
  color: ProfileColor;
}

/**
 * Each project on the board with its own colour from the app's palette,
 * ordered by name, so a project keeps its colour while the set of projects
 * stays the same. Past eight projects the palette wraps.
 */
export function projectColorsOf(
  projects: readonly ({ id: string; name: string } | null | undefined)[],
): ProjectColor[] {
  const byId = new Map<string, string>();
  for (const project of projects) {
    if (project !== null && project !== undefined && !byId.has(project.id)) {
      byId.set(project.id, project.name);
    }
  }
  return [...byId]
    .sort(
      ([aId, aName], [bId, bName]) =>
        aName.localeCompare(bName) || aId.localeCompare(bId),
    )
    .map(([id, name], index) => ({
      id,
      name,
      color: PROFILE_COLORS[index % PROFILE_COLORS.length]!,
    }));
}
