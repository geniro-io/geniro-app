import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import {
  searchTerms,
  snippetAround,
} from '../adapters/utils/session-search.utils';
import type { ChatSearchHit, ChatSearchResult } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { searchableText } from '../utils/searchable-text';

/** Hits returned when the caller names no ceiling of its own. */
const DEFAULT_SEARCH_LIMIT = 50;

/**
 * How much of a matching line one hit quotes.
 *
 * Wider than the session picker's 160, because that row also carries a title
 * and a folder to recognise the conversation by, while a transcript hit has
 * only the quote: the row IS the evidence that this is the message you meant.
 */
const SNIPPET_MAX_CHARS = 200;

/**
 * Finding a message inside ONE conversation.
 *
 * A daemon route rather than a filter in the client, and that is the whole
 * reason it exists: the renderer holds at most `HISTORY_PAGE` items and knows
 * more exist, so a client-side search answers only about the newest page and
 * says nothing about having missed the rest — which is silent by construction
 * and exactly wrong for the case somebody opens a search box for.
 *
 * Its own service rather than another method on `ChatService`, which is already
 * the largest class in the module and owns turn execution; this reads two rows
 * and formats them.
 */
@Injectable()
export class ChatSearchService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
  ) {}

  async search(
    runId: string,
    query: string,
    limit?: number,
  ): Promise<ChatSearchResult> {
    const em = this.em.fork();
    // Checked rather than inferred from an empty result: "this conversation
    // does not exist" and "nothing in it matches" are different answers, and
    // only the first is a 4xx.
    if ((await this.runDao.getById(runId, em)) === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return { hits: [], partialReason: null };
    }
    const cap = limit ?? DEFAULT_SEARCH_LIMIT;
    // One more than asked for, purely to learn whether there ARE more — a count
    // query would scan the same rows twice to answer the same question.
    const rows = await this.itemDao.searchByText(runId, terms, cap + 1, em);
    const capped = rows.length > cap;
    return {
      hits: rows.slice(0, cap).map((row) => this.toHit(row, terms)),
      partialReason: capped
        ? `showing the newest ${cap} matches — add a word to narrow it`
        : null,
    };
  }

  /**
   * One row as a hit.
   *
   * The snippet is cut from the payload's OWN text rather than from the stored
   * `searchText`, which is lowercased for the query's benefit: a user reading
   * their own sentence back in lower case would look like a bug in the app
   * rather than an implementation detail of the column.
   */
  private toHit(
    row: {
      seq: number;
      kind: ChatSearchHit['kind'];
      role: string | null;
      payload: string;
      createdAt: Date;
    },
    terms: readonly string[],
  ): ChatSearchHit {
    const text = searchableText(parseOrNull(row.payload)) ?? '';
    const haystack = text.toLowerCase();
    // The FIRST term this line answers for, so the window lands on something
    // the user actually typed. A row matched on every term by construction, but
    // not every term need appear in the DISPLAY text — the stored index form
    // folded case, and this one has not.
    const term = terms.find((candidate) => haystack.includes(candidate));
    return {
      seq: row.seq,
      kind: row.kind,
      role: row.role,
      snippet: snippetAround(text, term ?? '', SNIPPET_MAX_CHARS),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** A stored payload back to structure, or null when it will not parse. */
function parseOrNull(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}
