import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { UsageRecordedEvent } from '../stats.types';

/**
 * In-process pub-sub for the usage LEDGER — one event per turn actually
 * written, for whoever is showing what the app has spent.
 *
 * A separate bus from {@link AgentEventBus} rather than a fourth stream on it,
 * because the two announce different facts: the agent bus says a turn produced
 * an item, this says a ledger ROW now exists. A client refetching stats off the
 * agent bus would read the ledger in the window between those two writes and
 * see the turn it was told about missing — the reader is what makes the
 * distinction load-bearing, not tidiness.
 *
 * Published AFTER the row is durable, for exactly the same reason the item bus
 * is published after the item is (persist-then-emit): a subscriber's only
 * reaction is to go and read the table.
 */
@Injectable()
export class UsageEventBus {
  private readonly recorded = new Subject<UsageRecordedEvent>();

  publish(event: UsageRecordedEvent): void {
    this.recorded.next(event);
  }

  /** Every recorded turn, for the single fan-out subscriber (the gateway). */
  all(): Observable<UsageRecordedEvent> {
    return this.recorded.asObservable();
  }
}
