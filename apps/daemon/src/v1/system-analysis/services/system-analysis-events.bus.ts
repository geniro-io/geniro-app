import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { SystemAnalysesChangedEvent } from '../system-analysis.types';

/**
 * What Settings' past analyses show of one system analysis changed. The
 * notifications gateway broadcasts it as `system_analyses_changed`, so the
 * list re-reads without polling. Published after the write.
 */
@Injectable()
export class SystemAnalysisEventBus {
  private readonly changes = new Subject<SystemAnalysesChangedEvent>();

  publishChanged(runId: string): void {
    this.changes.next({ runId });
  }

  allChanges(): Observable<SystemAnalysesChangedEvent> {
    return this.changes.asObservable();
  }
}
