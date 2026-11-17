export const CALL_ENDPOINT_SELF_CHECK_BUDGETS_MS = [
  3_000, 10_000, 30_000,
] as const;

function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
}

/**
 * JSON-RPC `initialize` against a run's MCP endpoint: null when it answers 2xx,
 * else why not. A timeout moves on to the next budget; any other failure is final.
 * Every attempt asks for its own connection: a pooled keep-alive socket the
 * server has already closed would otherwise fail it with `fetch failed`.
 */
export async function probeCallEndpoint(
  endpoint: { url: string; token: string },
  budgetsMs: readonly number[] = CALL_ENDPOINT_SELF_CHECK_BUDGETS_MS,
): Promise<string | null> {
  for (const budget of budgetsMs) {
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${endpoint.token}`,
          connection: 'close',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'geniro-selfcheck', version: '0' },
          },
        }),
        signal: AbortSignal.timeout(budget),
      });
      return res.ok ? null : `HTTP ${res.status}`;
    } catch (err) {
      if (!isTimeout(err)) {
        return err instanceof Error ? err.message : String(err);
      }
    }
  }
  const seconds = Math.round(budgetsMs.reduce((sum, ms) => sum + ms, 0) / 1000);
  return `timed out after ${budgetsMs.length} attempts (${seconds}s)`;
}
