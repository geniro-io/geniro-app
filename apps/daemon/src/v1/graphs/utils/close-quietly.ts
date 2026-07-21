/**
 * Fire-and-forget teardown for per-request MCP transports/servers: the close
 * runs off any await chain (a response-stream `close` listener), so a rejected
 * close would otherwise surface as an unhandled rejection on every dropped
 * request — noise, not signal, for a resource that is gone either way.
 */
export function closeQuietly(closable: { close(): Promise<void> }): void {
  closable.close().catch(() => {});
}
