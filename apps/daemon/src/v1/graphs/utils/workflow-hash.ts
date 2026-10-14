import { createHash } from 'node:crypto';

/**
 * A workflow file's version, as a save quotes it back: the builder and an
 * analysis each send the hash they read, and the store refuses a save over a
 * file that has changed since (`WORKFLOW_CHANGED`).
 */
export function workflowFileHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}
