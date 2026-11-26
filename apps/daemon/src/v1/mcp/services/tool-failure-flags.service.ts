import { Injectable } from '@nestjs/common';

import {
  AGENT_FLAG_DETAIL_MAX,
  AUTO_FLAG_REFUSAL_STREAK,
  AUTO_FLAG_REFUSAL_WINDOW_MS,
} from '../../agents/chat.types';
import { FlagBroker } from '../../agents/services/flag.broker';
import {
  autoFlagCause,
  minutesLostBetween,
} from '../../agents/utils/agent-flags';
import type { McpToolResult } from '../mcp.types';

/** One served `tools/call`: who made it, on which endpoint, and when it started. */
export interface ServedToolCall {
  runId: string;
  memberId: string;
  conversationId: string | null;
  caller: string;
  endpointPath: string;
  tool: string;
  startedAt: number;
}

interface RefusalStreak {
  since: number;
  last: number;
  count: number;
}

/**
 * The daemon's own flags for geniro's tools: a call that timed out or failed
 * inside geniro, and one tool answering with an error again and again in one
 * conversation. Each raises at most one flag per tool per thread
 * (`FlagBroker.raiseAutomatic`); the streak of error answers is counted per
 * endpoint and tool, in memory, and a call that succeeds ends it, as does
 * `AUTO_FLAG_REFUSAL_WINDOW_MS` without another error answer.
 */
@Injectable()
export class ToolFailureFlagsService {
  private readonly streaks = new Map<string, RefusalStreak>();

  constructor(private readonly flags: FlagBroker) {}

  answered(call: ServedToolCall, result: McpToolResult): void {
    const now = Date.now();
    this.dropStale(now);
    const key = `${call.endpointPath}\u0000${call.tool}`;
    const text = result.content.map((part) => part.text).join('\n');
    if (result.failure !== undefined) {
      this.raise(
        call,
        autoFlagCause.toolFailure(call.tool),
        result.failure === 'timeout'
          ? `${call.tool} timed out`
          : `${call.tool} failed inside geniro`,
        text,
        call.startedAt,
      );
      return;
    }
    if (!result.isError) {
      this.streaks.delete(key);
      return;
    }
    const streak = this.streaks.get(key) ?? {
      since: call.startedAt,
      last: now,
      count: 0,
    };
    streak.count += 1;
    streak.last = now;
    if (streak.count < AUTO_FLAG_REFUSAL_STREAK) {
      this.streaks.set(key, streak);
      return;
    }
    this.streaks.delete(key);
    this.raise(
      call,
      autoFlagCause.toolRefused(call.tool),
      `${call.tool} refused ${streak.count} times running`,
      text,
      streak.since,
    );
  }

  private dropStale(now: number): void {
    for (const [key, streak] of this.streaks) {
      if (now - streak.last > AUTO_FLAG_REFUSAL_WINDOW_MS) {
        this.streaks.delete(key);
      }
    }
  }

  /** A call whose tool threw, which the SDK answers as an internal error. */
  threw(call: ServedToolCall, err: unknown): void {
    this.raise(
      call,
      autoFlagCause.toolFailure(call.tool),
      `${call.tool} failed inside geniro`,
      err instanceof Error ? err.message : String(err),
      call.startedAt,
    );
  }

  private raise(
    call: ServedToolCall,
    cause: string,
    summary: string,
    detail: string,
    since: number,
  ): void {
    void this.flags.raiseAutomatic(call.runId, {
      cause,
      seq: null,
      memberId: call.memberId,
      conversationId: call.conversationId,
      caller: call.caller,
      summary,
      detail: detail.slice(0, AGENT_FLAG_DETAIL_MAX),
      minutesLost: minutesLostBetween(since, Date.now()),
    });
  }
}
