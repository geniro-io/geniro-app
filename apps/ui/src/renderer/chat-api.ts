import type {
  ChatItem,
  ChatRun,
  CliKind,
  DaemonHandle,
} from '../shared/contracts';

/**
 * Thin REST client to the loopback daemon's chat routes. The renderer talks to
 * the daemon directly over loopback HTTP (the documented transport), carrying
 * the per-launch bearer token on every request. Streaming items arrive on the
 * WS channel ({@link DaemonClient}); this client is for commands + history.
 */
export class ChatApi {
  private readonly base: string;
  private readonly token: string;

  constructor(handle: DaemonHandle) {
    this.base = `http://${handle.host}:${handle.port}`;
    this.token = handle.token;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `daemon ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    return (await res.json()) as T;
  }

  createChat(input: {
    agentKind: CliKind;
    cwd: string;
    model?: string;
    title?: string;
  }): Promise<ChatRun> {
    return this.request('POST', '/v1/chats', input);
  }

  listChats(): Promise<ChatRun[]> {
    return this.request('GET', '/v1/chats');
  }

  getHistory(runId: string, afterSeq?: number): Promise<ChatItem[]> {
    const query = afterSeq === undefined ? '' : `?afterSeq=${afterSeq}`;
    return this.request(
      'GET',
      `/v1/chats/${encodeURIComponent(runId)}/items${query}`,
    );
  }

  sendMessage(runId: string, text: string): Promise<ChatItem> {
    return this.request(
      'POST',
      `/v1/chats/${encodeURIComponent(runId)}/messages`,
      { text },
    );
  }

  cancel(runId: string): Promise<{ cancelled: boolean }> {
    return this.request(
      'POST',
      `/v1/chats/${encodeURIComponent(runId)}/cancel`,
    );
  }
}
