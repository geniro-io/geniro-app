import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import { type SessionTranscriptTarget, SINGLE_AGENT_NODE } from '../chat.types';
import { NodeStateDao } from '../dao/node-state.dao';
import { readNodeSessions } from '../utils/node-sessions';
import { snapshotNodeConfigDirs } from '../utils/snapshot-config-dirs';
import { AgentAdapterRegistry } from './agent-adapter.registry';

/**
 * The CLI's own copy of a deleted run's conversations — the transcripts claude,
 * cursor and codex keep in their own stores, which outlive geniro's rows unless
 * something removes them. Asked for as "delete old transcripts when an archived
 * chat gets deleted as well (automatically or manually)".
 *
 * Two halves, because they have to happen at different moments of a delete:
 * WHICH conversations is read from `node_state` before the teardown destroys
 * those rows, and the deleting happens after the run's processes are closed and
 * its rows are gone. How each CLI deletes is its adapter's
 * (`AgentAdapter.deleteSessionTranscript`); this decides only what to ask.
 *
 * It keeps a conversation in two cases, and both are about data that is not
 * this run's to destroy. One another run still names (`sessionIdsHeldByOtherRuns`)
 * belongs to that thread too. One that began before the run was IMPORTED from the
 * user's own CLI — each adapter checks that against `runCreatedAt`, since only
 * the CLI's store knows when a conversation began.
 */
@Injectable()
export class SessionTranscriptsService {
  private readonly logger = new Logger(SessionTranscriptsService.name);

  constructor(
    private readonly nodeStateDao: NodeStateDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /**
   * Every CLI conversation a run held, with the CLI and the profile it lives
   * under. Read BEFORE the run's `node_state` rows are deleted.
   *
   * A chat's one node runs under the run's own profile; a workflow node under
   * the one its snapshot names. A node's whole session history is taken, not
   * only the session it would resume: every call to it and every compaction
   * starts another conversation, and each is a transcript on disk.
   */
  async collect(
    run: Run,
    em: EntityManager,
  ): Promise<SessionTranscriptTarget[]> {
    const nodeDirs = snapshotNodeConfigDirs(run.workflowSnapshot);
    const targets: SessionTranscriptTarget[] = [];
    for (const state of await this.nodeStateDao.listByRun(run.id, em)) {
      const agentKind = state.agentKind ?? run.agentKind;
      if (agentKind === null) {
        continue;
      }
      const configDir =
        run.workflowId === null && state.nodeId === SINGLE_AGENT_NODE
          ? run.configDir
          : (nodeDirs.get(state.nodeId) ?? null);
      const sessions = new Set(readNodeSessions(state.sessionIds));
      if (state.agentSessionId) {
        sessions.add(state.agentSessionId);
      }
      for (const sessionId of sessions) {
        targets.push({ agentKind, sessionId, configDir });
      }
    }
    return targets;
  }

  /**
   * Ask each conversation's CLI to delete it. Never throws, and one failure
   * does not stop the rest: the run is already deleted by the time this runs,
   * and a transcript left behind is a log line, not a failed delete.
   */
  async remove(
    runId: string,
    runCreatedAt: Date,
    targets: readonly SessionTranscriptTarget[],
    em: EntityManager,
  ): Promise<void> {
    if (targets.length === 0) {
      return;
    }
    let held: Set<string>;
    try {
      held = await this.nodeStateDao.sessionIdsHeldByOtherRuns(
        runId,
        targets.map((target) => target.sessionId),
        em,
      );
    } catch (error) {
      // Not knowing whether another thread uses a conversation is not a reason
      // to guess that none does.
      this.logger.warn(
        `kept the CLI transcripts of run ${runId}: could not check whether another run uses them: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    let deleted = 0;
    for (const target of targets) {
      if (held.has(target.sessionId)) {
        this.logger.log(
          `kept ${target.agentKind} conversation ${target.sessionId}: another run still uses it`,
        );
        continue;
      }
      try {
        const result = await this.adapters
          .for(target.agentKind)
          .deleteSessionTranscript({
            sessionId: target.sessionId,
            configDir: target.configDir,
            runCreatedAt,
          });
        if (result.deleted) {
          deleted += 1;
        } else {
          this.logger.log(
            `kept ${target.agentKind} conversation ${target.sessionId}: ${result.reason}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `could not delete ${target.agentKind} conversation ${target.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(
      `run ${runId}: deleted ${deleted} of ${targets.length} CLI conversation transcript(s)`,
    );
  }
}
