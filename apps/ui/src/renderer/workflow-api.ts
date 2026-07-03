import type {
  ChatRun,
  DaemonHandle,
  NodeStateWire,
  Workflow,
  WorkflowSummary,
  WorkflowWire,
} from '../shared/contracts';

/**
 * Thin REST client to the loopback daemon's workflow routes (library CRUD +
 * runs), mirroring {@link ChatApi}'s transport: loopback HTTP with the
 * per-launch bearer token. Run transcripts stream over the WS channel and
 * replay via the chats history read — both run-scoped, shared with chats.
 */
export class WorkflowApi {
  private readonly base: string;
  private readonly token: string;

  constructor(handle: DaemonHandle) {
    this.base = `http://${handle.host}:${handle.port}`;
    this.token = handle.token;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

  list(): Promise<WorkflowSummary[]> {
    return this.request('GET', '/v1/workflows');
  }

  get(slug: string): Promise<WorkflowWire> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(slug)}`);
  }

  create(workflow: Workflow, slug?: string): Promise<WorkflowWire> {
    return this.request('POST', '/v1/workflows', { workflow, slug });
  }

  save(slug: string, workflow: Workflow): Promise<WorkflowWire> {
    return this.request('PUT', `/v1/workflows/${encodeURIComponent(slug)}`, {
      workflow,
    });
  }

  delete(slug: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/v1/workflows/${encodeURIComponent(slug)}`);
  }

  import(path: string): Promise<WorkflowWire> {
    return this.request('POST', '/v1/workflows/import', { path });
  }

  export(slug: string, path: string): Promise<{ exported: boolean }> {
    return this.request(
      'POST',
      `/v1/workflows/${encodeURIComponent(slug)}/export`,
      { path },
    );
  }

  run(slug: string, input: { cwd: string; prompt: string }): Promise<ChatRun> {
    return this.request(
      'POST',
      `/v1/workflows/${encodeURIComponent(slug)}/runs`,
      input,
    );
  }

  listRuns(): Promise<ChatRun[]> {
    return this.request('GET', '/v1/workflows/runs');
  }

  getRunNodes(runId: string): Promise<NodeStateWire[]> {
    return this.request(
      'GET',
      `/v1/workflows/runs/${encodeURIComponent(runId)}/nodes`,
    );
  }

  cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    return this.request(
      'POST',
      `/v1/workflows/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }
}
