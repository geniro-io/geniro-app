import { EntityManager } from '@mikro-orm/sqlite';
import { Inject, Injectable } from '@nestjs/common';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import { environment } from '../../../environments';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { AgentVersionService } from '../../agents/services/agent-version.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { resolveAgentBinary } from '../../agents/utils/agent-binary';
import { type DiagnosticsReport } from '../diagnostics.types';
import { DebugLogService } from './debug-log.service';

/** How many log lines ride along with a report. */
const REPORT_TAIL = 200;

/**
 * The one-paste answer to "what is your setup and what just happened".
 *
 * Every field here is something a maintainer would otherwise extract from the
 * user one question at a time — which version, which CLI, was anything
 * running, where does your data live. Assembling it on the daemon rather than
 * in the renderer is what makes it TRUE: the renderer would be reporting what
 * it believes about a process it cannot see, and the interesting failures are
 * exactly the ones where those two disagree.
 *
 * It carries no secrets. The tail is already redacted by the sink, and nothing
 * else here is a credential — the launch token is deliberately absent even
 * though this service could reach it.
 */
@Injectable()
export class DiagnosticsReportService {
  constructor(
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly versions: AgentVersionService,
    private readonly processes: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly log: DebugLogService,
  ) {}

  async build(): Promise<DiagnosticsReport> {
    const now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(),
      daemon: {
        version: this.runtime.version,
        pid: process.pid,
        host: environment.host,
        port: this.runtime.port,
        startedAt: new Date(this.runtime.startedAt).toISOString(),
        uptimeSeconds: Math.round((now - this.runtime.startedAt) / 1000),
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        userDataDir: environment.userDataDir,
        logFilePath: this.log.filePath(),
      },
      agents: await this.agents(),
      runs: await this.runs(),
      recentEntries: this.log.page(-1, REPORT_TAIL).entries,
    };
  }

  /**
   * Each CLI as the daemon can actually see it — the binary it would spawn and
   * the version that binary answers with.
   *
   * Iterated over the ADAPTER REGISTRY, never a hardcoded list of CLI names: a
   * third agent must appear here the day it is added, and a report that
   * silently omits the agent someone is having trouble with is worse than no
   * report. The version probe is the same cached one the rest of the daemon
   * uses, so building a report never spawns anything new.
   */
  private async agents(): Promise<DiagnosticsReport['agents']> {
    return await Promise.all(
      [...this.adapters.all().keys()].map(async (kind) => {
        const binary = resolveAgentBinary(kind);
        // `resolve` never throws and never hangs — a CLI that is not installed
        // comes back as null, which is a FACT about this machine and one of the
        // likeliest reasons a report is being read at all. Said as a reason
        // rather than left as a bare null the reader has to interpret.
        const version = await this.versions.resolve(kind);
        return {
          kind,
          binary,
          version,
          unavailableReason:
            version === null
              ? `${binary} did not report a version — it may not be installed, or not on the daemon's PATH`
              : null,
        };
      }),
    );
  }

  private async runs(): Promise<DiagnosticsReport['runs']> {
    const em = this.em.fork();
    // COUNTED in SQLite, never loaded and length-ed: a long-lived install has
    // thousands of runs, and materialising all of them to produce two integers
    // would make asking for a diagnostics report the slowest thing the daemon
    // does — on a machine already thought to be misbehaving.
    return {
      total: await this.runDao.count({}, em),
      running: await this.runDao.count({ status: 'running' }, em),
      liveTurns: this.processes.activeCount,
      liveSessions: this.sessions.liveCount,
    };
  }
}
