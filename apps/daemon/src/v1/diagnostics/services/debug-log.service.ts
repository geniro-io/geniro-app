import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { AgentEventBus } from '../../agents/services/agent-events.bus';
import {
  type DebugChannel,
  type DebugEntry,
  type DebugLevel,
  type DebugLogPage,
  type UiLogInput,
} from '../diagnostics.types';
import { debugSink } from '../utils/debug-sink';

/** Longest a transcript payload preview runs before the sink truncates it. */
const PAYLOAD_PREVIEW = 400;

/**
 * The injectable face of {@link debugSink}, and the one place the TRANSCRIPT
 * channel is fed.
 *
 * The sink itself is module-scope because it must predate Nest (see its doc).
 * This adds the two things that need DI: a subscription to `AgentEventBus`, so
 * every persisted item and every status change is recorded as it happens, and
 * a shutdown hook that closes the file.
 *
 * Recording the transcript plane here rather than inside `ChatService` is not
 * incidental. The bus is where BOTH execution paths converge — the chat turn
 * and the graph executor publish through it — so one subscription covers
 * both, and neither has to remember to log. It is also the exact plane the
 * duplicate-seq defect lived in: a run of items whose seq repeats is visible
 * at a glance here, where it took a database query to find before.
 */
@Injectable()
export class DebugLogService implements OnModuleInit, OnApplicationShutdown {
  constructor(private readonly bus: AgentEventBus) {}

  onModuleInit(): void {
    // The seq is what makes this channel worth reading: it is the field a
    // reader compares across rows, so it leads the line.
    this.bus.all().subscribe((event) => {
      this.record(
        'transcript',
        'info',
        `item seq=${event.item.seq} ${event.item.kind}` +
          `${event.item.role ? `/${event.item.role}` : ''}` +
          ` ${preview(event.item.payload)}`,
        {
          runId: event.runId,
          ...(event.item.nodeId ? { nodeId: event.item.nodeId } : {}),
          seq: String(event.item.seq),
          kind: event.item.kind,
        },
      );
    });
    this.bus.allStatuses().subscribe((event) => {
      // A null status is an activity announce, not a status change. Writing it
      // as `run null` would be worse than useless in the one log a user pastes
      // into a bug report, and stamping a `status` field the event never
      // carried would have the log assert exactly what the null exists to deny.
      this.record(
        'transcript',
        'info',
        event.title !== undefined
          ? `run named: ${event.title}`
          : event.status === null
            ? // ABSENT and null are different answers, and `??` collapses them:
              // an announce that never read the activity would be recorded as
              // the run doing nothing, which is the assertion the field's third
              // state exists to avoid making.
              event.activity === undefined
              ? 'run status announce'
              : `run activity: ${event.activity ?? 'none'}`
            : `run ${event.status}${event.activity ? ` — ${event.activity}` : ''}`,
        {
          runId: event.runId,
          ...(event.status === null ? {} : { status: event.status }),
        },
      );
    });
    this.bus.allDeleted().subscribe((runId) => {
      this.record('transcript', 'warn', 'run deleted', { runId });
    });
    // Deltas are the EPHEMERAL live-text plane — thousands of events per turn,
    // each carrying the whole tail again. Recorded at `trace` so they are
    // present for anyone chasing a streaming bug but filtered out of the
    // default reading, and without their text, which the durable item already
    // carries verbatim one channel over.
    this.bus.allDeltas().subscribe((event) => {
      this.record('transcript', 'trace', 'delta', {
        runId: event.runId,
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        chars: String(event.text?.length ?? 0),
      });
    });
  }

  onApplicationShutdown(): void {
    debugSink.close();
  }

  record(
    channel: DebugChannel,
    level: DebugLevel,
    message: string,
    context?: Record<string, string> | null,
  ): void {
    debugSink.record(channel, level, message, context);
  }

  /** A line the RENDERER produced, tagged so its origin is never in doubt. */
  recordFromUi(input: UiLogInput): void {
    debugSink.record('ui', input.level, input.message, input.context ?? null);
  }

  page(afterSeq: number, limit?: number): DebugLogPage {
    const { entries, dropped } = debugSink.since(afterSeq, limit);
    return {
      entries,
      lastSeq: debugSink.lastSeq(),
      dropped,
      channels: debugSink.enabledChannels(),
      filePath: debugSink.filePath(),
    };
  }

  setChannels(channels: readonly DebugChannel[]): DebugChannel[] {
    debugSink.setChannels(channels);
    // Said in the log itself: a reader looking at a thin stretch of log needs
    // to be able to tell "nothing happened" from "this channel was off".
    debugSink.record(
      'daemon',
      'info',
      `debug channels set to [${channels.join(', ')}]`,
      null,
    );
    return debugSink.enabledChannels();
  }

  enabledChannels(): DebugChannel[] {
    return debugSink.enabledChannels();
  }

  filePath(): string | null {
    return debugSink.filePath();
  }

  /** Live entries, for the WS fan-out. */
  stream(): Observable<DebugEntry> {
    return debugSink.stream$().asObservable();
  }
}

/** A short, single-line rendering of an item payload. */
function preview(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > PAYLOAD_PREVIEW
    ? `${flat.slice(0, PAYLOAD_PREVIEW)}…`
    : flat;
}
