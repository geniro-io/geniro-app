import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { environment } from '../../../environments';
import {
  HEARTBEAT_EVERY_MS,
  writeHeartbeat,
} from '../../../utils/previous-stop';

/**
 * Keeps `daemon-heartbeat.json` current — pid, start, the beat's time and the
 * daemon's own resident memory — so the next boot can say how this process
 * ended when it leaves no other record. Started at bootstrap, after the boot
 * reconcile has read the previous daemon's beat.
 */
@Injectable()
export class DaemonHeartbeatService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DaemonHeartbeatService.name);
  private readonly startedAt = Math.round(Date.now() - process.uptime() * 1000);
  private timer: ReturnType<typeof setInterval> | null = null;
  private failing = false;

  onApplicationBootstrap(): void {
    this.beat();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  beat(now: number = Date.now()): void {
    try {
      writeHeartbeat(environment.userDataDir, {
        pid: process.pid,
        startedAt: this.startedAt,
        at: now,
        rssBytes: process.memoryUsage.rss(),
      });
      this.failing = false;
    } catch (err) {
      if (!this.failing) {
        this.logger.warn(
          `could not write the heartbeat: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.failing = true;
    }
  }
}
