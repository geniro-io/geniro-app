import type { RunProjectRef } from '../chat.types';

export function runProjectRefOf(
  projectId: string | null,
  projectName: string | null,
): RunProjectRef | null {
  return projectId !== null && projectName !== null
    ? { id: projectId, name: projectName }
    : null;
}
