import type { DaemonHandle } from '../shared/contracts';

/** HTTP verbs the loopback REST clients use. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Ceiling on every loopback request. The daemon is local — a healthy route
 * answers in milliseconds — so a request still pending after this long means
 * a wedged daemon, and without a bound the awaiting renderer action (a send
 * button, a run start) hangs forever with no feedback.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Base for every loopback-daemon REST client. Owns the one transport concern —
 * bearer-token auth, JSON encoding, and the uniform error shape
 * (`daemon <METHOD> <path> failed (<status>): <detail>`, which the renderer
 * tests parse) — so ChatApi / WorkflowApi / TerminalApi contribute only their
 * typed route methods. Extracted per the renderer "promote a pattern on its
 * second occurrence" rule; a transport fix now lands in exactly one place.
 */
export abstract class DaemonRestApi {
  private readonly base: string;
  private readonly token: string;

  constructor(handle: DaemonHandle) {
    this.base = `http://${handle.host}:${handle.port}`;
    this.token = handle.token;
  }

  protected async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // content-type only travels WITH a body: Fastify 400s a bodyless POST
    // that claims application/json (FST_ERR_CTP_EMPTY_JSON_BODY), and the
    // cancel routes are exactly that shape.
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `daemon ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    return (await res.json()) as T;
  }
}
