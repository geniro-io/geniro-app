/** DI token for the per-launch {@link RuntimeInfo}. */
export const RUNTIME_TOKEN = Symbol('GENIRO_DAEMON_RUNTIME');

/** Per-launch runtime facts shared across providers (DI value). */
export interface RuntimeInfo {
  /** Loopback bearer token minted for this launch. */
  token: string;
  version: string;
  /** `Date.now()` captured at process start, for uptime reporting. */
  startedAt: number;
  /**
   * The actually-bound loopback port — null until the server listens
   * (main.ts sets it from `onListening`; portFallback may shift it off the
   * preferred port). Consumers that mint URLs (the MCP endpoint for caller
   * agents) must treat null as "not routable yet".
   */
  port: number | null;
}
