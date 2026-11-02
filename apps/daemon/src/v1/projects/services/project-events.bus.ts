import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { ProjectsChangedEvent } from '../projects.types';

/**
 * In-process pub-sub for project writes — the `MemoryEventBus` shape. Every
 * write through `ProjectsService` publishes after it is flushed, and the
 * notifications gateway broadcasts each event as `projects_changed`.
 */
@Injectable()
export class ProjectEventBus {
  private readonly changes = new Subject<ProjectsChangedEvent>();

  publish(event: ProjectsChangedEvent): void {
    this.changes.next(event);
  }

  allChanges(): Observable<ProjectsChangedEvent> {
    return this.changes.asObservable();
  }
}
