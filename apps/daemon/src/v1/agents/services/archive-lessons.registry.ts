import { Injectable } from '@nestjs/common';

import type { ArchiveLessons } from '../chat.types';

/**
 * What the archive dialog decided about a thread's lessons, held from the
 * archive route until the lessons module, which sits above this one, closes
 * the stretch that archive ends.
 */
@Injectable()
export class ArchiveLessonsRegistry {
  private readonly choices = new Map<string, ArchiveLessons>();

  expect(runId: string, choice: ArchiveLessons): void {
    this.choices.set(runId, choice);
  }

  forget(runId: string): void {
    this.choices.delete(runId);
  }

  take(runId: string): ArchiveLessons | undefined {
    const choice = this.choices.get(runId);
    this.choices.delete(runId);
    return choice;
  }
}
