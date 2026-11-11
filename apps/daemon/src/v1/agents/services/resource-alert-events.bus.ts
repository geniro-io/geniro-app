import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

/** Broadcast by the notifications gateway as `resource_alerts_changed`. */
@Injectable()
export class ResourceAlertEventBus {
  private readonly changes = new Subject<void>();

  publish(): void {
    this.changes.next();
  }

  allChanges(): Observable<void> {
    return this.changes.asObservable();
  }
}
