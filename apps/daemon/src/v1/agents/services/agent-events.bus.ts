import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { RunItemEvent } from '../chat.types';

/**
 * In-process pub-sub for persisted run items — the `session_stream`-style bus.
 * The chat service publishes each item AFTER it is persisted (persist-then-emit)
 * so the durable transcript is always the source of truth; the notifications
 * gateway subscribes and fans events out to per-run Socket.IO rooms. RxJS only
 * (no `@nestjs/event-emitter`), since `rxjs` is already a daemon dependency.
 */
@Injectable()
export class AgentEventBus {
  private readonly subject = new Subject<RunItemEvent>();

  publish(event: RunItemEvent): void {
    this.subject.next(event);
  }

  /** All run-item events, for a single fan-out subscriber (the gateway). */
  all(): Observable<RunItemEvent> {
    return this.subject.asObservable();
  }
}
