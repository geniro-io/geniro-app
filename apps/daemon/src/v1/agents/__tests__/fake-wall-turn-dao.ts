import type { WallTurnRecord } from '../dao/wall-turn.dao';

/**
 * The wall ledger, on the real DAO's terms (pinned in `wall-turn.dao.spec.ts`):
 * one row per `(runId, seq)`, a second record of a turn ignored, only positive
 * figures written.
 */
export class FakeWallTurnDao {
  readonly rows = new Map<string, { runId: string } & WallTurnRecord>();
  async record(runId: string, turns: readonly WallTurnRecord[]): Promise<void> {
    for (const turn of turns) {
      const key = `${runId}:${turn.seq}`;
      if (turn.ms > 0 && !this.rows.has(key)) {
        this.rows.set(key, { runId, ...turn });
      }
    }
  }
  async runSum(runId: string): Promise<number> {
    let ms = 0;
    for (const row of this.rows.values()) {
      if (row.runId === runId) {
        ms += row.ms;
      }
    }
    return ms;
  }
  async nodeSums(runId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (row.runId === runId && row.nodeId !== null) {
        out.set(row.nodeId, (out.get(row.nodeId) ?? 0) + row.ms);
      }
    }
    return out;
  }
  async nodeTurnsBySeq(runId: string): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const row of this.rows.values()) {
      if (row.runId === runId && row.nodeId !== null) {
        out.set(row.seq, row.ms);
      }
    }
    return out;
  }
  async chatSums(runIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (runIds.includes(row.runId) && row.nodeId === null) {
        out.set(row.runId, (out.get(row.runId) ?? 0) + row.ms);
      }
    }
    return out;
  }
  async hardDeleteIncludingSoftDeleted(where: {
    runId: string;
  }): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.runId === where.runId) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
