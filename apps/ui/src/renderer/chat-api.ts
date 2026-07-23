import type {
  AgentSkill,
  ChatApprovalMode,
  ChatItem,
  ChatRun,
  CliKind,
} from '../shared/contracts';
import { DaemonRestApi } from './daemon-rest';

/**
 * Thin REST client to the loopback daemon's chat routes. The renderer talks to
 * the daemon directly over loopback HTTP (the documented transport), carrying
 * the per-launch bearer token on every request. Streaming items arrive on the
 * WS channel ({@link DaemonClient}); this client is for commands + history.
 */
export class ChatApi extends DaemonRestApi {
  createChat(input: {
    agentKind: CliKind;
    cwd: string;
    model?: string;
    title?: string;
    approval?: ChatApprovalMode;
  }): Promise<ChatRun> {
    return this.request('POST', '/v1/chats', input);
  }

  /** Flip the chat's approval mode between turns (409 RUN_BUSY mid-turn). */
  patchSettings(runId: string, approval: ChatApprovalMode): Promise<ChatRun> {
    return this.request(
      'PATCH',
      `/v1/chats/${encodeURIComponent(runId)}/settings`,
      { approval },
    );
  }

  listChats(): Promise<ChatRun[]> {
    return this.request('GET', '/v1/chats');
  }

  /** Run-level rename — the daemon accepts chat AND workflow runs here. */
  rename(runId: string, title: string): Promise<ChatRun> {
    return this.request('PATCH', `/v1/chats/${encodeURIComponent(runId)}`, {
      title,
    });
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

  /** Skills / slash commands `agentKind` accepts in `cwd` (`/` autocomplete). */
  listSkills(agentKind: CliKind, cwd: string): Promise<AgentSkill[]> {
    const query = `agent=${encodeURIComponent(agentKind)}&cwd=${encodeURIComponent(cwd)}`;
    return this.request('GET', `/v1/agents/skills?${query}`);
  }

  cancel(runId: string): Promise<{ cancelled: boolean }> {
    return this.request(
      'POST',
      `/v1/chats/${encodeURIComponent(runId)}/cancel`,
    );
  }
}
