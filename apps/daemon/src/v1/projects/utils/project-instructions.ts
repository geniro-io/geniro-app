import { hasControlCharacters } from '../../agents/chat.types';
import type { Project } from '../entity/project.entity';

/**
 * What a run is told about its project: the name, then the description, then
 * the instructions. Null when the project has neither, so a bare project adds
 * nothing to the turn.
 */
export function projectInstructionsText(
  project: Pick<Project, 'name' | 'description' | 'instructions'>,
): string | null {
  const description = project.description?.trim();
  const instructions = project.instructions?.trim();
  if (!description && !instructions) {
    return null;
  }
  const name = hasControlCharacters(project.name)
    ? [...project.name].filter((char) => !hasControlCharacters(char)).join('')
    : project.name;
  return [`Project: ${name}`, description, instructions]
    .filter((paragraph): paragraph is string => Boolean(paragraph))
    .join('\n\n');
}
