import { Injectable, type OnModuleInit } from '@nestjs/common';
import { map, merge, type Observable, Subject } from 'rxjs';

import { ActionCommandRegistry } from './action-command.registry';
import { AgentEventBus } from './agent-events.bus';
import { ChatService } from './chat.service';
import { HostWakeChatDelivery } from './host-wake-chat-delivery.service';
import { MonitorRegistry } from './monitor.registry';
import { MonitorChatDelivery } from './monitor-chat-delivery.service';

/** Whether one kind of work outside a turn still holds a run. */
export type RunLiveWorkSource = (runId: string) => boolean;

/**
 * The one answer to "does this run still have work going outside a turn" —
 * a monitor, a command action, a detached command or background sub-agent,
 * output or a wake waiting to start a turn. Each of them runs in, or wakes
 * the agent into, the run's folder, so nothing may take that folder away
 * while one holds the run. A kept CLI with nothing going is not work.
 *
 * The team module registers its own sources ({@link register}), since this
 * module may not import it.
 */
@Injectable()
export class RunLiveWork implements OnModuleInit {
  private readonly sources = new Map<string, RunLiveWorkSource>();
  private readonly released = new Subject<string>();

  constructor(
    private readonly bus: AgentEventBus,
    private readonly monitors: MonitorRegistry,
    private readonly commands: ActionCommandRegistry,
    private readonly chats: ChatService,
    private readonly monitorOutput: MonitorChatDelivery,
    private readonly hostWakes: HostWakeChatDelivery,
  ) {}

  onModuleInit(): void {
    this.register('monitor', (runId) => this.monitors.isRunning(runId));
    this.register('command action', (runId) => this.commands.isRunning(runId));
    this.register('background work', (runId) =>
      this.chats.holdsBackgroundWork(runId),
    );
    this.register('monitor output', (runId) =>
      this.monitorOutput.owesOutput(runId),
    );
    this.register('host wake', (runId) => this.hostWakes.owesWake(runId));
    this.monitors.subscribe((event) => {
      if (event.type === 'end') {
        this.released.next(event.monitor.owner.runId);
      }
    });
    this.commands.onIdle((runId) => this.released.next(runId));
  }

  /** Add a source under a name; the returned function removes it. */
  register(name: string, source: RunLiveWorkSource): () => void {
    this.sources.set(name, source);
    return () => {
      if (this.sources.get(name) === source) {
        this.sources.delete(name);
      }
    };
  }

  /** The first kind of work holding the run, or null when nothing does. */
  heldBy(runId: string): string | null {
    for (const [name, source] of this.sources) {
      if (source(runId)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Runs whose live work may have ended: a monitor or command action ending,
   * a status announce (a count of detached commands or sub-agents, a turn
   * settling) or a transcript row. Ask {@link heldBy} again on each.
   */
  changes(): Observable<string> {
    return merge(
      this.released,
      this.bus.allStatuses().pipe(map((event) => event.runId)),
      this.bus.all().pipe(map((event) => event.runId)),
    );
  }
}
