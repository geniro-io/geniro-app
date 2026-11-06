import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { KnowledgeChangedEvent } from '../knowledge.types';

/**
 * In-process pub-sub for knowledge writes — the `MemoryEventBus` shape. The
 * gateway broadcasts each event as `knowledge_changed`.
 */
@Injectable()
export class KnowledgeEventBus {
  private readonly changes = new Subject<KnowledgeChangedEvent>();

  publish(event: KnowledgeChangedEvent): void {
    this.changes.next(event);
  }

  allChanges(): Observable<KnowledgeChangedEvent> {
    return this.changes.asObservable();
  }
}
