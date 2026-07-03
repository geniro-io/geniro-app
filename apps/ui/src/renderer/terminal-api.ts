import type { TerminalSession } from '../shared/contracts';
import { DaemonRestApi } from './daemon-rest';

/**
 * Thin REST client to the loopback daemon's terminal routes. Session lifecycle
 * (open/close) is HTTP; the byte plane (attach, input, resize) rides the
 * `/terminals` Socket.IO namespace ({@link TerminalClient}).
 */
export class TerminalApi extends DaemonRestApi {
  create(input: {
    runId: string;
    nodeId?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSession> {
    return this.request('POST', '/v1/terminals', input);
  }

  list(): Promise<TerminalSession[]> {
    return this.request('GET', '/v1/terminals');
  }

  dispose(id: string): Promise<{ disposed: boolean }> {
    return this.request('DELETE', `/v1/terminals/${encodeURIComponent(id)}`);
  }
}
