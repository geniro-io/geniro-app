import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { TaskChangedEvent } from '../tasks.types';

/**
 * In-process pub-sub for task writes, the {@link TaskChangedEvent}-style bus
 * for the board's own `task_changed` broadcast — the RxJS shape of
 * `AgentEventBus` (`v1/agents/services/agent-events.bus.ts`), narrowed to the
 * one stream this module needs.
 *
 * `TasksService` publishes each event AFTER its write is flushed
 * (persist-then-emit), so a subscriber reacting to the event always finds the
 * row already durable; the notifications gateway subscribes and broadcasts to
 * every client, on `run_status`'s own reasoning — a board a user is not
 * looking at still needs its cards to move.
 */
@Injectable()
export class TaskEventBus {
  private readonly changes = new Subject<TaskChangedEvent>();

  publishTaskChanged(event: TaskChangedEvent): void {
    this.changes.next(event);
  }

  /** Every task write, for the single fan-out subscriber (the gateway). */
  allChanges(): Observable<TaskChangedEvent> {
    return this.changes.asObservable();
  }
}
