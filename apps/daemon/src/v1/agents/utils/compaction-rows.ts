import type { AgentEvent } from '../adapters/adapter.types';
import type { MappedItem } from './event-to-item';

/**
 * What a compaction the CLI finished says in the transcript when it reported no
 * summary text of its own — the row still has to say that it HAPPENED.
 */
export const COMPACTED_WITHOUT_SUMMARY =
  'The conversation was compacted to free up context. The agent reported no summary of what it kept.';

/**
 * The marker stamped on a compaction's row.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts` reads this
 * `compaction` key back to caption the collapsed row. An item payload is
 * `z.unknown()` on the wire BY DESIGN, so no generated type spans the two sides
 * — renaming a field here means renaming it there.
 */
export interface CompactionMarker {
  preTokens: number | null;
  postTokens: number | null;
  /** `auto` (the window filled) or `manual` (`/compact`); null if unstated. */
  trigger: string | null;
}

/**
 * Every compaction the CLI FINISHED becomes exactly one transcript row — for
 * one turn's (or one off-turn stretch's) stream of events.
 *
 * The boundary has the figures and no text; the CLI's injected summary has the
 * text and no figures. When the summary follows, the figures are stamped onto
 * its row, as they always were. What this adds is the other case: a boundary
 * that NO summary follows still gets a row of its own, written ahead of
 * whatever the stream produces next.
 *
 * That case is the common one, which is how it went unnoticed. Measured on the
 * author's database: 238 of 239 compaction rows followed a `/compact`. claude
 * 2.1.266 builds the synthetic summary line on its local-command path, so an
 * AUTOMATIC compaction — the window filling mid-turn — put only the boundary on
 * the stream, the summary never reached the mapper, and the transcript carried
 * no sign that the agent had forgotten most of the conversation. Reported as "if
 * agent auto compacting conversation I don't see a system message".
 *
 * A delegate's events are left alone: a sub-agent compacting its OWN context
 * is not the conversation the user is reading.
 */
export class CompactionRows {
  private pending: CompactionMarker | null = null;

  /** Whether a compaction is still waiting for its row. */
  get holding(): boolean {
    return this.pending !== null;
  }

  /**
   * The compaction rows to write BEFORE `mapped` (the row `event` becomes, or
   * null when it becomes none).
   *
   * When `event` is the CLI's summary for the held compaction, nothing is
   * returned and the marker is stamped onto `mapped.payload` in place.
   */
  rowsBefore(event: AgentEvent, mapped: MappedItem | null): MappedItem[] {
    if (event.type === 'context_compacted') {
      if (event.phase !== 'finished' || event.parentToolUseId !== undefined) {
        return [];
      }
      // Two boundaries with nothing between them are two compactions.
      const held = this.flush();
      this.pending = {
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        trigger: event.trigger,
      };
      return held;
    }
    if (mapped === null || this.pending === null) {
      return [];
    }
    if (
      event.type === 'notice' &&
      event.origin === 'cli' &&
      event.parentToolUseId === undefined
    ) {
      mapped.payload = { ...mapped.payload, compaction: this.pending };
      this.pending = null;
      return [];
    }
    return this.flush();
  }

  /** The held compaction's own row, if one is still owed. */
  flush(): MappedItem[] {
    const marker = this.pending;
    if (marker === null) {
      return [];
    }
    this.pending = null;
    return [
      {
        kind: 'system',
        role: null,
        payload: {
          message: COMPACTED_WITHOUT_SUMMARY,
          severity: 'info',
          compaction: marker,
        },
      },
    ];
  }
}
