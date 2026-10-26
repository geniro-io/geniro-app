import { randomUUID } from 'node:crypto';

/**
 * A tag nobody can name in advance — what fences text geniro did not write
 * (a command's output, an agent's note) inside a message a model reads, so
 * the text cannot close the fence and speak as the app.
 */
export function randomFenceTag(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
