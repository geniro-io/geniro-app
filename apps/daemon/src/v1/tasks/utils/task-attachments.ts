import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { environment } from '../../../environments';

/** The shape this module's own attachment directories are named by. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a card's pasted images live. */
export function taskAttachmentsRoot(): string {
  return join(environment.userDataDir, 'task-attachments');
}

/**
 * Drop every image pasted into one card.
 *
 * A pure helper rather than a method, because it has TWO callers in two
 * modules — a card being deleted, and a board being deleted with its cards —
 * and `ProjectsModule` may not import the tasks module (the dependency runs
 * tasks → projects and never back). Extracting is what the module rule asks
 * for here; a second copy is how one of them comes to miss a bound.
 *
 * The id's SHAPE is checked before the join, which is the whole safety
 * argument: this is the one recursive delete in the module, and an id arriving
 * from a route param must not be able to name a path outside the root. `force`
 * makes a card that pasted nothing a no-op rather than a throw.
 */
export async function removeTaskAttachments(
  taskId: string,
  root: string = taskAttachmentsRoot(),
): Promise<void> {
  if (!UUID.test(taskId)) {
    return;
  }
  await rm(join(root, taskId), { recursive: true, force: true });
}
