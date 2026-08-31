import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Item } from '../../runs/entity/item.entity';
import { messageText } from '../utils/message-preview';

/**
 * The SIDEBAR PREVIEW's one exclusion: a message a DELEGATE wrote.
 *
 * REPORTED as "I see last message in thread card is incorrect - maybe it's from
 * subagent? We sohuld only take last messages from parent thread". A delegate's
 * messages are ordinary `message` rows ON the run — that is what lets the
 * transcript nest them under their block — so the newest message of a fanned-out
 * turn is routinely one of theirs, and the row then previewed a conversation the
 * user cannot see from the sidebar at all.
 *
 * TWIN PARSER of `apps/ui/src/renderer/chats/subagent-payload.ts`
 * `subagentIdOf`: `parentToolUseId` is the key the daemon writes and the
 * renderer reads to place a row under its delegate, and a rename on either side
 * must be a rename on both.
 *
 * Matched against the payload TEXT rather than through `json_extract`, because
 * the column is TEXT holding JSON and every other reader here treats it that
 * way. The cost of the crude match is a message whose own words contain the key
 * name being skipped, which loses that run one preview line and falls back to
 * the message before it — the safe direction, and far cheaper than the failure
 * it prevents.
 */
const NOT_A_DELEGATE = {
  $not: { payload: { $like: '%parentToolUseId%' } },
} as const;

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
   * Text of each run's LATEST message, whoever said it — the chat list's
   * preview line.
   *
   * TWIN PARSER: `apps/ui/src/renderer/chats/chat-preview.ts`
   * `previewMessageOf` decides the same thing for a LIVE turn. The two take
   * turns writing this one line — the list value on a refetch, that one as
   * messages stream — so a rule held on only one side is a preview whose owner
   * depends on which source spoke last.
   *
   * It used to be the AGENT's latest, falling back to any role while the agent
   * had not spoken, deliberately: "the last message" alternates owner at every
   * turn boundary — the user's sentence echoed back while the agent works, then
   * the reply, then the user's again. REPORTED as "In thread i cant see last
   * user message. I should see there last AI or USER message": what that rule
   * costs is that a thread shows the previous answer for the whole time it is
   * working on what you just asked, so the row is stalest exactly when you go
   * looking for the chat you were last in. Alternation is the price of the
   * asked-for behaviour, and a preview tracks where a conversation has got to.
   *
   * Two bounded queries, never the full transcripts: first the (runId, seq)
   * pairs of message items (integers + ids only, no payloads), reduced to the
   * per-run head in memory, then just those head rows' payloads. Runs with no
   * message items (or a non-text payload) are simply absent from the map.
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
      { runId: { $in: runIds }, kind: 'message', ...NOT_A_DELEGATE },
      { fields: ['runId', 'seq'], disableIdentityMap: true },
    );
    // ONE head per run now — the highest seq. The role no longer decides
    // anything, so the two-map fold this used to need (an agent head and an
    // any-role head, resolved afterwards) collapses to a single running max.
    const headSeq = new Map<string, number>();
    for (const head of heads) {
      const prev = headSeq.get(head.runId);
      if (prev === undefined || head.seq > prev) {
        headSeq.set(head.runId, head.seq);
      }
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
        // Repeated with the head query above for the same reason the kind is:
        // this second read fetches BY (runId, seq), and a delegate's row can
        // share a seq with the head on a transcript written before
        // `ItemSeqAllocator` — so without it the row excluded a moment ago
        // comes back anyway.
        ...NOT_A_DELEGATE,
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
  firstUserMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.firstMessageText(runId, 'user', txEm);
  }

  /**
   * Text of the run's first ASSISTANT message — the other half of the exchange
   * a generated title is written from.
   *
   * It exists because the opening message is routinely a slash command and a
   * URL (`/geniro:implement https://…`), which names nothing: the agent's first
   * reply is where the subject of the conversation is first stated in words.
   */
  firstAssistantMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.firstMessageText(runId, 'assistant', txEm);
  }

  /**
   * The NEWEST message of one role in a run, or null when it has none.
   *
   * The mirror of {@link firstMessageText}, and it exists for the title ask: a
   * conversation opened with a bare URL has nothing nameable in its first
   * exchange (measured — the naming model answers "I need to see the Slack
   * thread…" rather than a title), while its third turn is about real work.
   * Re-asking with the same two messages would only reproduce the same
   * refusal, so a retry has to be given what the conversation has SINCE said.
   */
  lastUserMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.edgeMessageText(runId, 'user', 'desc', txEm);
  }

  /** The newest thing the agent said, for the same reason. */
  lastAssistantMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.edgeMessageText(runId, 'assistant', 'desc', txEm);
  }

  private firstMessageText(
    runId: string,
    role: 'user' | 'assistant',
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.edgeMessageText(runId, role, 'asc', txEm);
  }

  /** One end of a run's messages of one role — the oldest or the newest. */
  private async edgeMessageText(
    runId: string,
    role: 'user' | 'assistant',
    direction: 'asc' | 'desc',
    txEm?: EntityManager,
  ): Promise<string | null> {
    const [row] = await this.getRepo(txEm).find(
      { runId, kind: 'message', role },
      {
        // The same total ordering `latestMessageTextPerRun` needs, for the same
        // reason: a transcript written before `ItemSeqAllocator` can hold two
        // rows on one seq, so seq alone does not decide which is first — or,
        // read the other way, which is last.
        orderBy: { seq: direction, createdAt: direction, id: direction },
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

  /**
   * Tool RESULTS newer than `afterSeq` whose text could name a pull request —
   * the candidate set the capture pass reads (`utils/pull-request-capture.ts`).
   *
   * The `LIKE` is a pre-filter, not the parser: it narrows thousands of rows to
   * the handful worth running a regex over, and everything it lets through is
   * checked properly upstream (a `…/pull/new/<branch>` push hint matches this
   * and is not a pull request). Bounded by `seq` so the pass is INCREMENTAL —
   * the `(run_id, seq)` index serves the range directly, so a settled run whose
   * marker is current reads no payloads at all.
   *
   * Results only. The tool CALL that produced one is fetched by id through
   * {@link findToolCallPair}, because a call and its result can straddle the
   * scanned boundary — the call was persisted on the previous pass and only its
   * result is new.
   */
  async pullRequestCandidates(
    runId: string,
    afterSeq: number,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      {
        runId,
        seq: { $gt: afterSeq },
        kind: 'tool_result',
        payload: { $like: '%/pull/%' },
      },
      {
        orderBy: { seq: 'asc' },
        fields: ['seq', 'payload'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Every `task_list` announcement a run has written, oldest first — the input
   * to `utils/task-list-fold.ts`.
   *
   * The WHOLE set rather than an incremental slice, unlike
   * {@link pullRequestCandidates} beside it, and the difference is what the two
   * scans cost. A pull-request scan reads `tool_result` rows, which are most of
   * a transcript (14,068 items on a real thread here), so it must be marked and
   * resumed. These are the rows an agent wrote ABOUT its own checklist, and
   * there are a few dozen at most — measured on real turns, fifteen for a
   * five-task claude run and six for the same job on cursor — served straight
   * off the `kind` index. Re-folding all of them is what makes the answer
   * correct with no marker to keep in step: a daemon restarted mid-conversation,
   * and every run that predates this column, fold identically to a live one.
   */
  async taskListRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'nodeId' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'task_list' },
      {
        orderBy: { seq: 'asc' },
        fields: ['nodeId', 'payload'],
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
