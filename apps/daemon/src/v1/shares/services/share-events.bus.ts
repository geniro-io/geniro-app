import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { ShareChangedEvent } from '../shares.types';

/**
 * In-process pub-sub for share row writes — the `TaskEventBus` shape. The
 * share service publishes after each write is flushed, and the notifications
 * gateway broadcasts each event as `shares_changed`.
 */
@Injectable()
export class ShareEventBus {
  private readonly changes = new Subject<ShareChangedEvent>();

  publish(event: ShareChangedEvent): void {
    this.changes.next(event);
  }

  /** Every share write, for the single fan-out subscriber (the gateway). */
  allChanges(): Observable<ShareChangedEvent> {
    return this.changes.asObservable();
  }
}
