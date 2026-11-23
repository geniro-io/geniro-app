import { Injectable, Optional } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import {
  EMBEDDING_CHAT_KNN_MAX,
  EMBEDDING_CHAT_KNN_PER_HIT,
} from '../../embeddings/embeddings.types';
import { EmbeddingIndexService } from '../../embeddings/services/embedding-index.service';
import { fuseRanks } from '../../embeddings/utils/rrf';
import { snippetAround } from '../adapters/utils/session-search.utils';
import {
  type ChatContextItem,
  type ChatContextQuery,
  ChatContextQuerySchema,
  type ChatContextResult,
  type ChatContextRow,
  type ChatTextMatch,
  type GlobalChatSearchQuery,
  GlobalChatSearchQuerySchema,
  type GlobalChatSearchResult,
  MAX_CONTEXT_ITEM_CHARS,
} from '../chat.types';
import { ChatSearchIndexDao } from '../dao/chat-search-index.dao';
import {
  chatTextMatchQuery,
  chatTextQueryTerms,
} from '../utils/chat-text-query';
import { messageText } from '../utils/message-preview';

/**
 * Search across every chat, and the read around a match — one implementation
 * behind both `GET /v1/chats/search` and the `search_chats` /
 * `read_chat_context` MCP tools, so the person and an agent get the same
 * answers.
 *
 * Matching is SQLite's own full-text index (`db/chat-text-index.ddl.ts`),
 * which the database keeps current inside every write: a message is
 * searchable the moment it is stored, with nothing to index later. With search
 * by meaning on, those word matches are fused with the nearest messages by
 * meaning, and `score` becomes the fused relevance in (0, 1].
 */
@Injectable()
export class GlobalChatSearchService {
  constructor(
    private readonly index: ChatSearchIndexDao,
    @Optional() private readonly embeddings?: EmbeddingIndexService,
  ) {}

  async search(input: GlobalChatSearchQuery): Promise<GlobalChatSearchResult> {
    const options = GlobalChatSearchQuerySchema.parse(input);
    const matchQuery = chatTextMatchQuery(options.query);
    if (matchQuery === null) {
      return { hits: [], partialReason: null };
    }
    // One more than asked for, only to learn whether there ARE more.
    const rows = await this.index.match(options, matchQuery, options.limit + 1);
    const terms = chatTextQueryTerms(options.query);
    const fused = await this.fusedWithMeaning(options, rows);
    if (fused !== null) {
      return {
        hits: fused.slice(0, options.limit).map(({ row, relevance }) => ({
          ...hitOf(row, terms),
          score: relevance,
        })),
        partialReason:
          fused.length > options.limit
            ? `Showing the best ${options.limit} matches — add a word to narrow it.`
            : null,
      };
    }
    return {
      hits: rows.slice(0, options.limit).map((row) => ({
        ...hitOf(row, terms),
        // bm25 is negative and smaller is better; the wire says higher is.
        score: -row.rank,
      })),
      partialReason:
        rows.length > options.limit
          ? `Showing the best ${options.limit} matches — add a word to narrow it.`
          : null,
    };
  }

  /**
   * The word matches fused with the nearest messages by meaning, best first,
   * or null when search by meaning is off or cannot answer.
   */
  private async fusedWithMeaning(
    options: GlobalChatSearchQuery,
    rows: readonly ChatTextMatch[],
  ): Promise<{ row: Omit<ChatTextMatch, 'rank'>; relevance: number }[] | null> {
    if (!this.embeddings?.enabled) {
      return null;
    }
    const k = Math.min(
      EMBEDDING_CHAT_KNN_MAX,
      EMBEDDING_CHAT_KNN_PER_HIT * options.limit,
    );
    const scoped = Boolean(options.runId) || Boolean(options.cwd);
    const meaning = await this.embeddings.searchChats(
      options.query,
      k,
      scoped ? await this.index.reachableRunIds(options) : null,
    );
    if (meaning === null) {
      return null;
    }
    const known = new Map<string, Omit<ChatTextMatch, 'rank'>>(
      rows.map((row) => [row.id, row]),
    );
    const reachable = await this.index.hitsAmong(
      options,
      meaning.map((hit) => hit.itemId).filter((id) => !known.has(id)),
    );
    for (const row of reachable) {
      known.set(row.id, row);
    }
    const relevance = fuseRanks([
      { ids: rows.map((row) => row.id), weight: 1 },
      {
        ids: meaning.map((hit) => hit.itemId).filter((id) => known.has(id)),
        weight: 1,
      },
    ]);
    return [...relevance]
      .flatMap(([id, score]) => {
        const row = known.get(id);
        return row ? [{ row, relevance: score }] : [];
      })
      .sort(
        (a, b) =>
          b.relevance - a.relevance || b.row.created_at - a.row.created_at,
      );
  }

  /** The messages around one row of a conversation, in order. */
  async context(input: ChatContextQuery): Promise<ChatContextResult> {
    const options = ChatContextQuerySchema.parse(input);
    const run = await this.index.run(options.runId);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${options.runId}`);
    }
    const target = await this.index.row(options.runId, options.itemId);
    if (!target) {
      throw new NotFoundException(
        'ITEM_NOT_FOUND',
        `no item ${options.itemId} in run ${options.runId}`,
      );
    }
    const before = await this.index.neighbours(
      target,
      'before',
      options.before,
    );
    const after = await this.index.neighbours(target, 'after', options.after);
    return {
      runId: run.id,
      title: run.title,
      cwd: run.cwd,
      archived: run.archived_at !== null,
      items: [
        ...before.reverse().map((row) => contextItem(row, false)),
        contextItem(target, true),
        ...after.map((row) => contextItem(row, false)),
      ],
    };
  }
}

/** How long a hit's quote is. */
const SNIPPET_CHARS = 240;

/**
 * A hit's quote, windowed on the first word the text answers for. Redacted
 * BEFORE it is cut: a credential spans several words, so a window edge inside
 * one would leave a fragment `redactSecrets` no longer recognises.
 */
function hitOf(row: Omit<ChatTextMatch, 'rank'>, terms: readonly string[]) {
  return {
    runId: row.run_id,
    itemId: row.id,
    memberId: row.member_id,
    title: row.title,
    cwd: row.cwd,
    archived: row.archived_at !== null,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    snippet: snippetOf(row.text, terms),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function snippetOf(text: string, terms: readonly string[]): string {
  const redacted = redactSecrets(text);
  // A plain lowercase search finds most words; the fold below walks the
  // whole text a character at a time, so it is taken only when that misses.
  const lower = redacted.toLowerCase();
  const sameLength = lower.length === redacted.length;
  let folded: string | undefined;
  for (const term of terms) {
    let at = sameLength ? lower.indexOf(term) : -1;
    if (at < 0) {
      folded ??= fold(redacted);
      at = folded.indexOf(fold(term));
    }
    if (at >= 0) {
      // The text's own spelling of the match, which `snippetAround` finds.
      const matched = redacted.slice(at, at + term.length).toLowerCase();
      return snippetAround(redacted, matched, SNIPPET_CHARS);
    }
  }
  return snippetAround(redacted, '', SNIPPET_CHARS);
}

/**
 * Lowercased with diacritics stripped, as the index compares (`cafe` matches
 * `Café`), keeping every character's position so an offset found in the
 * folded text is an offset in the original. A character whose folded form is
 * a different length is kept as it is.
 */
function fold(text: string): string {
  let out = '';
  for (const char of text) {
    const folded = char
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      // Lowercased alone, Σ is always σ; a typed word keeps its final ς.
      .replace('ς', 'σ');
    out += folded.length === char.length ? folded : char;
  }
  return out;
}

/**
 * Text handed to an agent is redacted first: a message can quote a credential
 * the daemon minted or a CLI inherited (`utils/redact.ts`), and this text goes
 * to whichever provider the asking agent talks to.
 */
function contextItem(row: ChatContextRow, target: boolean): ChatContextItem {
  const text = redactSecrets(messageText(row.payload) ?? '');
  return {
    itemId: row.id,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    memberId: row.member_id,
    text: text.slice(0, MAX_CONTEXT_ITEM_CHARS),
    truncated: text.length > MAX_CONTEXT_ITEM_CHARS,
    createdAt: new Date(row.created_at).toISOString(),
    target,
  };
}
