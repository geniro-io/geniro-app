import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type {
  AgentContextCategory,
  AgentContextMemoryFile,
  AgentContextServer,
  AgentContextUsage,
} from '../../adapter.types';
import { CLAUDE_CONTEXT_USAGE_SUBTYPE } from '../claude.const';

/**
 * Reading and writing the `get_context_usage` control dialogue — what the
 * window currently holds, broken down the way that CLI's own `/context`
 * breaks it down.
 *
 * Pure, like its `mcp_status` sibling and for the same reason: the session
 * primitive that carries it (`CliSession.ask`) knows no CLI's vocabulary, so
 * everything about this one lives here and can be exercised without a process.
 * The probe evidence, the reply's shape and the expiry warning are all at
 * {@link CLAUDE_CONTEXT_USAGE_SUBTYPE} in `claude.const.ts`.
 */

/** The `get_context_usage` request line, newline-terminated for the dialogue. */
export function contextUsageRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: CLAUDE_CONTEXT_USAGE_SUBTYPE },
  })}\n`;
}

/**
 * What one parsed stdout line says about the question `requestId` is waiting
 * on: the projected breakdown, or null for "not my reply, keep waiting".
 *
 * A REFUSAL also reads as null, which is the one place this differs from the
 * readiness gate's reader — there the difference between "not yet" and "never"
 * decides whether to keep polling, and here there is nothing to keep polling
 * for: one question, one answer, and both a refusal and a timeout leave the
 * caller with the same empty readout. Distinguishing them would buy a nuance
 * no consumer can act on.
 */
export function readContextUsageReply(
  obj: unknown,
  requestId: string,
): AgentContextUsage | null {
  const line = asRecord(obj);
  if (!line || line.type !== 'control_response') {
    return null;
  }
  const envelope = asRecord(line.response);
  if (!envelope || envelope.request_id !== requestId) {
    return null;
  }
  if (envelope.subtype !== 'success') {
    return null;
  }
  const body = asRecord(envelope.response);
  if (!body) {
    return null;
  }
  const categories = readCategories(body.categories);
  const memoryFiles = readMemoryFiles(body.memoryFiles);
  const servers = readServers(body.mcpTools);
  // A reply that carried NOTHING we can show is not an answer. Reading it as
  // one would put an empty panel on screen under a heading promising figures,
  // which is indistinguishable from a bug; null sends the caller down the
  // "this could not be read" path it already has for a timeout.
  if (
    categories.length === 0 &&
    memoryFiles.length === 0 &&
    servers.length === 0
  ) {
    return null;
  }
  return {
    categories,
    totalTokens: asNumber(body.totalTokens),
    // `maxTokens`, not `rawMaxTokens`: the two agreed on every reading taken
    // here, and the one to prefer is the one the CLI measures its own
    // percentage against.
    maxTokens: asNumber(body.maxTokens),
    model: asString(body.model),
    autoCompactAtTokens: asNumber(body.autoCompactThreshold),
    // Absent means "this build does not say", which is not the same as off —
    // `asBoolean` would coerce the absence into a false the CLI never stated.
    autoCompactEnabled:
      typeof body.isAutoCompactEnabled === 'boolean'
        ? body.isAutoCompactEnabled
        : null,
    memoryFiles,
    servers,
  };
}

/**
 * The category rows, in the CLI's own order.
 *
 * `Free space` is dropped rather than passed through: it is the remainder
 * (`maxTokens - totalTokens`), so keeping it would put a row in the list that
 * a consumer summing the list must then know to skip — and one that does not
 * know reports a window exactly twice as full as it is.
 */
function readCategories(value: unknown): AgentContextCategory[] {
  return asArray(value).flatMap((entry) => {
    const row = asRecord(entry);
    const name = row ? asString(row.name) : null;
    const tokens = row ? asNumber(row.tokens) : null;
    if (name === null || tokens === null || name === FREE_SPACE_CATEGORY) {
      return [];
    }
    return [{ name, tokens, deferred: asBoolean(row?.isDeferred) }];
  });
}

/** The CLI's own name for the row that is not a category but a remainder. */
const FREE_SPACE_CATEGORY = 'Free space';

function readMemoryFiles(value: unknown): AgentContextMemoryFile[] {
  return asArray(value).flatMap((entry) => {
    const row = asRecord(entry);
    const path = row ? asString(row.path) : null;
    const tokens = row ? asNumber(row.tokens) : null;
    if (path === null || tokens === null) {
      return [];
    }
    // `type` on the wire — the CLI's own word (`Project`, `AutoMem`), kept
    // verbatim rather than mapped into a geniro vocabulary that would have to
    // guess at the next one it invents.
    return [{ path, kind: asString(row?.type), tokens }];
  });
}

/**
 * The per-tool rows folded into one row per MCP server.
 *
 * The fold is the whole value of this field: a live reading carried 371 tools
 * over 46 servers, and the fact worth acting on — one server holding 109k of
 * the 274k — is invisible until they are summed. Done HERE rather than in the
 * renderer so the per-tool descriptions never cross the wire at all.
 */
function readServers(value: unknown): AgentContextServer[] {
  const byServer = new Map<string, AgentContextServer>();
  for (const entry of asArray(value)) {
    const row = asRecord(entry);
    const name = row ? asString(row.serverName) : null;
    const tokens = row ? asNumber(row.tokens) : null;
    if (name === null || tokens === null) {
      continue;
    }
    const server = byServer.get(name) ?? {
      name,
      tokens: 0,
      toolCount: 0,
      loadedToolCount: 0,
    };
    server.tokens += tokens;
    server.toolCount += 1;
    if (asBoolean(row?.isLoaded)) {
      server.loadedToolCount += 1;
    }
    byServer.set(name, server);
  }
  // Heaviest first: the list is read to find what is eating the window, and
  // the CLI's own order is by server discovery, which answers nothing.
  return [...byServer.values()].sort((a, b) => b.tokens - a.tokens);
}
