import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@packages/common';

import type {
  MemoryEntry,
  MemorySaveOutcome,
  MemoryStatusOutcome,
} from '../memory.types';

/**
 * How a near-duplicate refusal's message starts; the handles follow, comma
 * separated, so a client can vouch past exactly those.
 */
export const NEAR_DUPLICATE_PREFIX = 'similar entries exist: ';

/**
 * The entry a user's write produced, or the HTTP error its refusal is. A near
 * duplicate is `409 MEMORY_NEAR_DUPLICATE` naming the matching handles, which
 * the writer may vouch past with `notDuplicateOf`.
 *
 * TWIN PARSER: `nearDuplicateHandles` in `apps/ui/src/renderer/settings/memory.tsx`.
 */
export function savedEntryOrThrow(
  outcome: MemorySaveOutcome | MemoryStatusOutcome,
): MemoryEntry {
  switch (outcome.kind) {
    case 'created':
    case 'updated':
    case 'changed':
      return outcome.entry;
    case 'stale':
      throw new ConflictException(
        'MEMORY_STALE',
        'the entry changed since it was read — reload it and try again',
      );
    case 'near_duplicate': {
      const handles = [
        ...outcome.candidates.map((hit) => hit.handle),
        ...outcome.pending,
      ];
      throw new ConflictException(
        'MEMORY_NEAR_DUPLICATE',
        `${NEAR_DUPLICATE_PREFIX}${handles.join(', ')}`,
      );
    }
    case 'refused':
      if (outcome.code === 'NOT_FOUND') {
        throw new NotFoundException('MEMORY_NOT_FOUND', outcome.reason);
      }
      if (outcome.code === 'USER_ONLY' || outcome.code === 'UNDER_REVIEW') {
        throw new ForbiddenException(outcome.code, outcome.reason);
      }
      throw new BadRequestException(outcome.code, outcome.reason);
  }
}
