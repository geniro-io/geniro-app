import { Injectable } from '@nestjs/common';

/**
 * Per-caller-node MCP call tokens. The graph executor mints one token per
 * claude caller node of a run; the loopback guard accepts it ONLY on that
 * node's own `/v1/mcp/<runId>/<nodeId>` route; the executor revokes the whole
 * run's set when it settles. Keying by (runId, nodeId) — not just runId —
 * binds the credential to a single caller identity, so one callee child that
 * holds its own token cannot claim another node's route in the same run.
 *
 * In-memory by design — a call token must never outlive the daemon launch,
 * and a restart invalidates every outstanding one (callee children die with
 * the daemon anyway).
 */
@Injectable()
export class CallTokenRegistry {
  private readonly byRun = new Map<string, Map<string, string>>();

  /** Store `token` as the credential for `nodeId`'s MCP route in `runId`. */
  issue(runId: string, nodeId: string, token: string): void {
    let nodes = this.byRun.get(runId);
    if (!nodes) {
      nodes = new Map();
      this.byRun.set(runId, nodes);
    }
    nodes.set(nodeId, token);
  }

  /** The token authorizing `nodeId`'s route in `runId`, or null. */
  get(runId: string, nodeId: string): string | null {
    return this.byRun.get(runId)?.get(nodeId) ?? null;
  }

  /** Drop every token minted for a settled run. */
  revokeRun(runId: string): void {
    this.byRun.delete(runId);
  }
}
