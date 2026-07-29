import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { RunDeltaEvent, RunItemEvent } from '../chat.types';

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
  private readonly deltas = new Subject<RunDeltaEvent>();

  publish(event: RunItemEvent): void {
    this.subject.next(event);
  }

  /** All run-item events, for a single fan-out subscriber (the gateway). */
  all(): Observable<RunItemEvent> {
    return this.subject.asObservable();
  }

  /**
   * The EPHEMERAL live-text plane — a deliberately separate stream from
   * {@link publish}.
   *
   * Kept apart rather than widening `RunItemEvent` because that type's whole
   * meaning is "already persisted": one union would make it possible to hand a
   * never-persisted delta to a subscriber that reasonably assumes a durable
   * row exists behind it. Two streams make the invariant unmistakable at every
   * call site, and the gateway simply fans both into the same run room.
   */
  publishDelta(event: RunDeltaEvent): void {
    this.deltas.next(event);
  }

  /** All live-text events, for the same single fan-out subscriber. */
  allDeltas(): Observable<RunDeltaEvent> {
    return this.deltas.asObservable();
  }
}
