import { asArray, asRecord } from '../../../utils/json-util';
import type {
  AgentContextLastRequest,
  AgentContextUsage,
} from '../../adapter.types';
import { classifyMessage, encodeRequest } from '../../utils/json-rpc.utils';
import {
  CODEX_MCP_STATUS_DETAIL,
  CODEX_MCP_STATUS_PAGE_SIZE,
  CODEX_METHODS,
} from '../codex.const';
import type {
  CodexMcpServerStatus,
  CodexThreadFacts,
  CodexTokenBreakdown,
} from '../codex.types';
import { readCodexMcpServerStatus } from './codex-mcp.utils';

/**
 * The `mcpServerStatus/list` request put to a RUNNING codex process about its
 * own thread — which reuses that thread's MCP connections rather than dialling
 * anything — under a string id no frame of the session's own (numbered from 1)
 * can share.
 */
export function codexContextRequestLine(
  requestId: string,
  threadId: string,
): string {
  return encodeRequest(requestId, CODEX_METHODS.mcpServerStatusList, {
    threadId,
    detail: CODEX_MCP_STATUS_DETAIL,
    limit: CODEX_MCP_STATUS_PAGE_SIZE,
  });
}

/**
 * The servers in the reply to {@link codexContextRequestLine}: the list, `[]`
 * wrapped as a refusal when codex answered with an error, or null for any
 * other line (the ask's reader is offered every line the process prints).
 */
export function readCodexContextReply(
  obj: unknown,
  requestId: string,
): { servers: CodexMcpServerStatus[] | null } | null {
  const message = classifyMessage(obj);
  if (
    (message.kind !== 'response' && message.kind !== 'error') ||
    message.id !== requestId
  ) {
    return null;
  }
  if (message.kind === 'error') {
    return { servers: null };
  }
  const servers: CodexMcpServerStatus[] = [];
  for (const entry of asArray(asRecord(message.result)?.data)) {
    const status = readCodexMcpServerStatus(entry);
    if (status !== null) {
      servers.push(status);
    }
  }
  return { servers };
}

/** One request's split, with input reported FRESH as every reader here means it. */
export function codexLastRequest(
  last: CodexTokenBreakdown,
): AgentContextLastRequest {
  return {
    inputTokens: Math.max(
      0,
      last.inputTokens - last.cachedInputTokens - last.cacheWriteInputTokens,
    ),
    cachedInputTokens: last.cachedInputTokens,
    cacheWriteInputTokens: last.cacheWriteInputTokens,
    outputTokens: last.outputTokens,
    reasoningOutputTokens: last.reasoningOutputTokens,
  };
}

/**
 * What a codex thread's window holds, as far as codex says.
 *
 * codex counts tokens per REQUEST, not per kind of content, so there are no
 * categories here and nothing is invented to fill them: the size is its last
 * request's `totalTokens` — what codex itself draws as the window's fill — the
 * window is its `modelContextWindow`, and the split of that request is carried
 * as what it is (`lastRequest`). The instruction files the thread loaded and
 * the MCP servers connected to it are listed by NAME, with no token figure,
 * because codex reports none per file or per server.
 *
 * Only CONNECTED servers are listed: a server that is off or never started
 * puts nothing in the window. Its tools are all loaded — codex has no deferred
 * tool surface — so `loadedToolCount` is the count.
 */
export function codexContextUsage(
  facts: CodexThreadFacts | null,
  servers: CodexMcpServerStatus[] | null,
): AgentContextUsage {
  const usage = facts?.usage ?? null;
  const total = usage?.last.totalTokens ?? null;
  return {
    categories: [],
    totalTokens: total !== null && total > 0 ? total : null,
    maxTokens: usage?.modelContextWindow ?? null,
    model: facts?.model ?? null,
    autoCompactAtTokens: facts?.autoCompactTokens ?? null,
    // Only a threshold geniro set is KNOWN: codex's own default is not stated
    // anywhere it reports, so silence is unknown rather than "off".
    autoCompactEnabled: facts?.autoCompactTokens != null ? true : null,
    memoryFiles: (facts?.instructionSources ?? []).map((path) => ({
      path,
      kind: null,
      tokens: null,
    })),
    servers: (servers ?? [])
      .filter((server) => server.runtimeStatus === 'connected')
      .map((server) => ({
        name: server.name,
        tokens: null,
        toolCount: server.toolCount,
        loadedToolCount: server.toolCount,
      })),
    lastRequest: usage === null ? null : codexLastRequest(usage.last),
  };
}
