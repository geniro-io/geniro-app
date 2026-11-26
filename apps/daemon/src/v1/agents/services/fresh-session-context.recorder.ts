import { Injectable, Logger } from '@nestjs/common';

import { SessionContextReading } from '../../runs/entity/session-context-reading.entity';
import type { AgentSession } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { SessionContextReadingDao } from '../dao/session-context-reading.dao';

export interface FreshSessionContextInput {
  adapter: Pick<AgentAdapter, 'readContextUsage'>;
  live: AgentSession | null;
  runId: string;
  memberId: string;
  poolMember: number | null;
  sessionId: string;
  agent: string;
  model: string | null;
  configDir: string | null;
}

/**
 * Asks a freshly opened member session's CLI what its context holds and keeps
 * the answer for the team analysis. Best-effort: a CLI that cannot answer, or
 * a failed write, leaves nothing stored and never reaches the turn.
 */
@Injectable()
export class FreshSessionContextRecorder {
  private readonly logger = new Logger(FreshSessionContextRecorder.name);

  constructor(private readonly readings: SessionContextReadingDao) {}

  async record(input: FreshSessionContextInput): Promise<void> {
    if (input.live === null) {
      return;
    }
    try {
      const breakdown = await input.adapter.readContextUsage({
        live: input.live,
        sessionId: input.sessionId,
        configDir: input.configDir,
      });
      if (breakdown === null) {
        return;
      }
      const row = new SessionContextReading();
      row.runId = input.runId;
      row.sessionId = input.sessionId;
      row.memberId = input.memberId;
      row.poolMember = input.poolMember;
      row.agent = input.agent;
      row.model = input.model;
      row.breakdown = JSON.stringify(breakdown);
      await this.readings.save(row);
    } catch (err) {
      this.logger.warn(
        `context breakdown of ${input.runId}/${input.memberId} not stored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
