import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { MemoryChangedEvent } from '../memory.types';

/**
 * In-process pub-sub for memory writes — the `ShareEventBus` shape. The memory
 * service publishes after each write is flushed, and the notifications gateway
 * broadcasts each event as `memory_changed`.
 */
@Injectable()
export class MemoryEventBus {
  private readonly changes = new Subject<MemoryChangedEvent>();

  publish(event: MemoryChangedEvent): void {
    this.changes.next(event);
  }

  allChanges(): Observable<MemoryChangedEvent> {
    return this.changes.asObservable();
  }
}
