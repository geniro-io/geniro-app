import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Item } from '../../runs/entity/item.entity';
import { messageText } from '../utils/message-preview';

@Injectable()
export class ItemDao extends BaseDao<Item> {
  constructor(em: EntityManager) {
    super(em, Item);
  }

  /**
   * Ordered transcript for a run. `afterSeq` is the replay cursor: pass the
   * highest seq the client has already rendered to fetch only newer items
   * (default -1 returns the whole transcript, since seq starts at 0).
   *
   * `window` is the OTHER direction — the newest `limit` items, optionally
   * those before `beforeSeq`, for a client paging backwards through a long
   * conversation. Measured on a real thread: 7,814 items are 18.9MB of payload
   * where its newest 1,000 are 0.63MB, so opening a chat used to move thirty
   * times the bytes anybody was going to look at. The rows still come back in
   * ASCENDING seq whichever way they were selected, because every reader
   * downstream — the fold, the pairing, the turn scan — is written against a
   * transcript in the order it happened.
   */
  async getByRun(
    runId: string,
    afterSeq = -1,
    txEm?: EntityManager,
    window?: { limit: number; beforeSeq?: number },
  ): Promise<Item[]> {
    if (window) {
      const rows = await this.getRepo(txEm).find(
        {
          runId,
          seq: {
            $gt: afterSeq,
            ...(window.beforeSeq === undefined
              ? {}
              : { $lt: window.beforeSeq }),
          },
        },
        // Newest FIRST for the selection, so the limit takes the tail of the
        // conversation rather than its beginning, then reversed below.
        {
          orderBy: { seq: 'desc' },
          limit: window.limit,
          disableIdentityMap: true,
        },
      );
      return rows.reverse();
    }
    return this.getRepo(txEm).find(
      { runId, seq: { $gt: afterSeq } },
      // Read-only replay path: skip identity-map tracking so a long transcript
      // doesn't accumulate managed entities in the forked EM.
      { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * The two halves of ONE tool call of a run, by the CLI's own call id.
   *
   * Narrowed in SQL rather than by scanning the transcript, because the row
   * being looked for can be arbitrarily far back: a `pnpm dev` detached at the
   * start of a long session is exactly the command someone opens the output of,
   * and by then its launch sits thousands of items behind. The `$like` is over
   * the payload TEXT — an id is not a column — so the parsed payload is
   * re-checked below and the caller validates the id's shape before it gets
   * here, which is what keeps a `%` out of the pattern.
   */
  async findToolCallPair(
    runId: string,
    callId: string,
    txEm?: EntityManager,
  ): Promise<{ call: Item | null; result: Item | null }> {
    const rows = await this.getRepo(txEm).find(
      {
        runId,
        kind: { $in: ['tool_call', 'tool_result'] },
        payload: { $like: `%${callId}%` },
      },
      { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    );
    // `Item.payload` is JSON TEXT, not a parsed object — the column is `text`
    // and only the wire projection parses it. Reading `.id` off the string
    // matches nothing, which is a 404 for every command rather than an error.
    const idOf = (item: Item): string | null => {
      try {
        const payload: unknown = JSON.parse(item.payload);
        if (payload === null || typeof payload !== 'object') {
          return null;
        }
        const value = (payload as { id?: unknown }).id;
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    };
    const matched = rows.filter((row) => idOf(row) === callId);
    return {
      call: matched.find((row) => row.kind === 'tool_call') ?? null,
      // The LAST result wins: a transcript written before `ItemSeqAllocator`
      // can hold more than one row for a pair, and the later one is the one
      // that describes how the call actually ended.
      result:
        [...matched].reverse().find((row) => row.kind === 'tool_result') ??
        null,
    };
  }

  /**
   * Text of each run's latest AGENT message — the chat list's preview line.
   *
   * The agent's, not simply the newest of either role, and that is the whole
   * point of the method rather than a detail of it. A preview taken from "the
   * last message" alternates owner at every turn boundary: it is the user's own
   * sentence echoed back for as long as the agent is working, then the agent's
   * reply, then the user's again — reported as the preview flicking between the
   * two. Neither reading is wrong on its own, which is exactly why the line has
   * to pick ONE and keep it, and the useful one is what the thread last said to
   * the user. A run whose agent has not spoken yet falls back to the newest
   * message of any role, so a brand-new chat still previews the question that
   * started it rather than showing nothing.
   *
   * Two bounded queries, never the full transcripts: first the (runId, seq,
   * role) triples of message items (integers + ids only, no payloads), reduced
   * to the per-run head in memory, then just those head rows' payloads. Runs
   * with no message items (or a non-text payload) are simply absent from the
   * map.
   */
  async latestMessageTextPerRun(
    runIds: string[],
    txEm?: EntityManager,
  ): Promise<Map<string, string>> {
    if (runIds.length === 0) {
      return new Map();
    }
    const repo = this.getRepo(txEm);
    const heads = await repo.find(
      { runId: { $in: runIds }, kind: 'message' },
      { fields: ['runId', 'seq', 'role'], disableIdentityMap: true },
    );
    // Two heads per run, resolved to one below: the newest agent message and
    // the newest message of any role. Tracking only a single "best so far"
    // cannot express the fallback — a run whose agent HAS spoken must ignore
    // every later user message, which is undecidable until the whole set is in.
    const agentSeq = new Map<string, number>();
    const anySeq = new Map<string, number>();
    for (const head of heads) {
      const prevAny = anySeq.get(head.runId);
      if (prevAny === undefined || head.seq > prevAny) {
        anySeq.set(head.runId, head.seq);
      }
      // Anything that is not the user is the thread talking back. Read as "not
      // user" rather than as an allowlist of agent role names, so a CLI that
      // spells its own role differently still previews instead of falling
      // silently back to echoing the user.
      if (head.role !== 'user') {
        const prevAgent = agentSeq.get(head.runId);
        if (prevAgent === undefined || head.seq > prevAgent) {
          agentSeq.set(head.runId, head.seq);
        }
      }
    }
    const headSeq = new Map<string, number>();
    for (const [runId, seq] of anySeq) {
      headSeq.set(runId, agentSeq.get(runId) ?? seq);
    }
    if (headSeq.size === 0) {
      return new Map();
    }
    const rows = await repo.find(
      {
        // The kind is repeated deliberately. `(runId, seq)` is not a key: a
        // transcript written before `ItemSeqAllocator` can hold two rows on one
        // seq, and without this filter a tool row sharing the head's number
        // comes back too — `messageText` reads null off it, and whichever of
        // the pair the database returned last decided whether the run had a
        // preview line at all.
        kind: 'message',
        $or: [...headSeq].map(([runId, seq]) => ({ runId, seq })),
      },
      {
        // Same reason, for the case where BOTH rows on that seq are messages:
        // an unordered read let the two take turns winning across refetches,
        // which is the sidebar preview flicking between the user's last message
        // and the agent's. `createdAt` is the tie-break the seq cannot be — the
        // later message is the later row — with the (random uuid) primary key
        // behind it only so the answer is total rather than merely usually
        // decided.
        orderBy: { seq: 'asc', createdAt: 'asc', id: 'asc' },
        fields: ['runId', 'payload'],
        disableIdentityMap: true,
      },
    );
    const previews = new Map<string, string>();
    for (const row of rows) {
      const text = messageText(row.payload);
      if (text !== null) {
        previews.set(row.runId, text);
      }
    }
    return previews;
  }

  /**
   * Text of the run's FIRST user message — what a chat is named after when its
   * CLI offers no title of its own.
   *
   * The opening message rather than the newest, and the opposite choice from
   * {@link latestMessageTextPerRun} for the opposite reason: a preview line
   * tracks where a conversation has got to, while a title names what it was
   * ever about, and a title that followed the newest message would rewrite the
   * sidebar under the user as they worked.
   *
   * One bounded query — the oldest user-role message row alone, projected to its
   * payload. `null` for a run with no user message yet, or one whose payload
   * carries no text; `ChatTitleService` leaves such a run unnamed rather than
   * titling it with a placeholder.
   */
  async firstUserMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const [row] = await this.getRepo(txEm).find(
      { runId, kind: 'message', role: 'user' },
      {
        // The same total ordering `latestMessageTextPerRun` needs, for the same
        // reason: a transcript written before `ItemSeqAllocator` can hold two
        // rows on one seq, so seq alone does not decide which is first.
        orderBy: { seq: 'asc', createdAt: 'asc', id: 'asc' },
        fields: ['payload'],
        limit: 1,
        disableIdentityMap: true,
      },
    );
    return row ? messageText(row.payload) : null;
  }

  /**
   * Every `turn_complete` payload of a run, oldest first — what the thread's
   * spend is summed from.
   *
   * Its own query rather than a filter over `getByRun`: a long conversation's
   * transcript is thousands of rows of text and tool payloads, and the totals
   * need the handful that carry usage. Projected to `payload` alone for the
   * same reason.
   */
  async turnCompletePayloads(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { runId, kind: 'turn_complete' },
      {
        orderBy: { seq: 'asc' },
        fields: ['payload'],
        disableIdentityMap: true,
      },
    );
    return rows.map((row) => row.payload);
  }

  /**
   * Every `turn_complete` row in the database, across all runs — what the usage
   * ledger's boot backfill sweeps to recover history recorded before it existed.
   *
   * Cross-run and carrying its row's identity, unlike {@link turnCompletePayloads},
   * which answers for ONE run and projects the payload alone. The backfill needs
   * `runId` + `seq` to key each turn idempotently and `createdAt` to date it, so
   * it cannot be expressed as a loop over that method.
   *
   * Projected to those five fields and filtered to the one kind that carries
   * usage: this runs once per boot, and hydrating full rows would pull every
   * conversation's text through memory to read a handful of integers. The kind
   * filter rides `Item`'s own `kind` index — added FOR this query, since every
   * other read here is scoped by `runId` and rides the composite index instead.
   */
  async allTurnCompleteRows(
    since?: Date,
    txEm?: EntityManager,
  ): Promise<
    Pick<Item, 'runId' | 'nodeId' | 'seq' | 'payload' | 'createdAt'>[]
  > {
    return this.getRepo(txEm).find(
      {
        kind: 'turn_complete',
        // `since` bounds the sweep to turns the ledger cannot already hold.
        // Without it every launch read the user's whole history to learn it had
        // nothing to do, so start-up cost grew forever.
        ...(since === undefined ? {} : { createdAt: { $gte: since } }),
      },
      {
        fields: ['runId', 'nodeId', 'seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /** Highest seq persisted for a run, or -1 when the run has no items yet. */
  async maxSeq(runId: string, txEm?: EntityManager): Promise<number> {
    // Project ONLY `seq` — this runs on every sendMessage; hydrating the full
    // newest Item (incl. its text payload) just to read one integer is wasteful.
    const last = await this.getRepo(txEm).findOne(
      { runId },
      { orderBy: { seq: 'desc' }, fields: ['seq'], disableIdentityMap: true },
    );
    return last ? last.seq : -1;
  }
}
