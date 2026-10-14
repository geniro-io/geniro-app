import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import type {
  ChatHistoryWire,
  HistoryConversation,
  HistoryWindow,
  ItemWire,
  SeqRange,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { OUTSIDE_ANY_CALL } from '../utils/call-membership';
import {
  anchorNeedsOf,
  callStartOf,
  conversationCallIds,
  isOutside,
  pageBoundsOf,
  rowsOfCalls,
  rowsWithId,
  workflowEdgeRows,
} from '../utils/history-anchors';
import { itemToWire } from '../utils/item-wire';
import { ChatService } from './chat.service';
import { ItemCallIndexService } from './item-call-index.service';

/**
 * The kinds of a call's rows a folded card reads whole — see `cardRowsFor`.
 *
 * TWIN PARSER: `buildCallBlock` and the stalled / held folds of
 * `groupTranscript` in apps/ui/src/renderer/chats/transcript-groups.ts, with
 * `callBlockSummary` / `callBlockActivity` / `callBlockTasks` — a reading a
 * folded card starts taking from another kind of row goes empty on a page of
 * the run's own flow until that kind is listed here.
 */
const CARD_KINDS: readonly ItemKind[] = [
  'status',
  'task_list',
  'turn_complete',
  'system',
];

/**
 * A call's newest {@link CARD_KINDS} rows a page anchors, at most. A call with
 * more is one whose earliest readings no folded card shows any longer; its
 * settle states how it ended either way.
 */
const CARD_ROWS_PER_CALL = 150;

/**
 * A call's newest NAMED tool calls a page anchors. More than one, because the
 * card's activity line is the newest one it does not hide — a task-list tool,
 * one of geniro's own — and which those are is the renderer's to decide.
 */
const NAMED_TOOLS_PER_CALL = 8;

/**
 * One page of a run's transcript together with its ANCHORS — the rows outside
 * the page its rows refer to (`GET /v1/chats/:runId/items`).
 *
 * The page itself is `ChatService.getHistory`'s, unchanged; this only decides
 * what else the page needs and reads it. Every read is either scoped to a kind
 * a run holds a handful of (calls, workflow announcements) or matched by id on
 * the side of the page the row can be on — a tool call before the rows that
 * name it, a reply after its call. A by-id read is a JSON-path pass over the
 * run's rows of that kind on that side: cheap after the newest page, a walk of
 * the history before it, taken only when the page names something it lacks.
 */
@Injectable()
export class ChatHistoryService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly calls: ItemCallIndexService,
  ) {}

  async read(
    runId: string,
    afterSeq = -1,
    window?: HistoryWindow,
    conversation?: HistoryConversation,
  ): Promise<ChatHistoryWire> {
    const inCalls =
      conversation === undefined
        ? undefined
        : await this.conversationKeys(runId, conversation);
    const items = await this.chats.getHistory(runId, afterSeq, window, inCalls);
    // A full page asked with a probe carries one row the client will drop; its
    // anchors would draw a card with no row of the window behind it.
    const kept =
      window?.probe === true && items.length === window.limit
        ? window.take === 'oldest'
          ? items.slice(0, -1)
          : items.slice(1)
        : items;
    const anchors = await this.anchorsFor(runId, kept, inCalls !== undefined);
    if (
      inCalls === undefined ||
      conversation === undefined ||
      !('root' in conversation)
    ) {
      return { items, anchors };
    }
    const byId = new Map(anchors.map((row) => [row.id, row] as const));
    for (const row of await this.cardRowsFor(runId, [...kept, ...anchors])) {
      byId.set(row.id, row);
    }
    return {
      items,
      anchors: [...byId.values()].sort((a, b) => a.seq - b.seq),
    };
  }

  /**
   * What the call cards a page of the run's own flow draws are folded from,
   * when the page holds none of their conversations: each call's newest status
   * rows, task lists, turn ends and notices, and its newest row, newest words
   * and newest named tool calls — the readings a folded card shows. The rest of
   * a call's conversation is read when its card is opened. One bounded read of
   * each per call, newest first off the `(runId, inCall, kind, seq)` index.
   */
  private async cardRowsFor(
    runId: string,
    held: readonly ItemWire[],
  ): Promise<ItemWire[]> {
    const callIds = [
      ...new Set(
        held
          .map(callStartOf)
          .filter((start) => start !== null)
          .map((start) => start.callId),
      ),
    ];
    if (callIds.length === 0) {
      return [];
    }
    const em = this.em.fork();
    const rows = [];
    for (const callId of callIds) {
      const newest = (
        pick: Parameters<ItemDao['newestRowsInCall']>[2],
      ): Promise<Item[]> =>
        this.itemDao.newestRowsInCall(runId, callId, pick, em);
      rows.push(
        ...(await newest({ kinds: CARD_KINDS, limit: CARD_ROWS_PER_CALL })),
        ...(await newest({ limit: 1 })),
        // The newest words and NAMED tools: the folded card's readings walk
        // back past a blank message and an ACP tool call naming nothing.
        ...(await newest({ kinds: ['message'], said: 'text', limit: 1 })),
        ...(await newest({
          kinds: ['tool_call'],
          said: 'name',
          limit: NAMED_TOOLS_PER_CALL,
        })),
      );
    }
    return rows.map(itemToWire);
  }

  /** The `inCall` values one conversation's rows carry; undefined for every row of the run. */
  private async conversationKeys(
    runId: string,
    conversation: HistoryConversation,
  ): Promise<string[] | undefined> {
    if (!(await this.calls.holdsCalls(runId))) {
      return undefined;
    }
    await this.calls.ensureIndexed(runId);
    if ('root' in conversation) {
      return [OUTSIDE_ANY_CALL];
    }
    return [
      ...conversationCallIds(
        await this.calls.callStartsOf(runId),
        new Set([conversation.call]),
      ),
    ];
  }

  async anchorsFor(
    runId: string,
    page: readonly ItemWire[],
    /**
     * The page is ONE conversation of the run, so rows of the others lie
     * between its bounds without being in it: a call's settle sits among the
     * caller's rows. Its call rows are then read by the calls' ids, and a row
     * is outside the page when the page does not hold it.
     */
    scoped = false,
  ): Promise<ItemWire[]> {
    const bounds = pageBoundsOf(page);
    if (bounds === null) {
      return [];
    }
    const needs = anchorNeedsOf(page);
    const em = this.em.fork();
    const anchors = new Map<string, ItemWire>();
    const held = new Set(page.map((row) => row.id));
    const add = (rows: readonly ItemWire[]): void => {
      for (const row of rows) {
        if (scoped ? !held.has(row.id) : isOutside(row.seq, bounds)) {
          anchors.set(row.id, row);
        }
      }
    };
    const callRange: SeqRange | undefined = scoped
      ? undefined
      : { outside: bounds };
    const addById = async (
      kinds: readonly ItemKind[],
      ids: ReadonlySet<string>,
      range: SeqRange,
    ): Promise<void> => {
      if (ids.size === 0) {
        return;
      }
      const rows = await this.itemDao.rowsByPayloadId(
        runId,
        kinds,
        [...ids],
        range,
        em,
      );
      add(rowsWithId(rows.map(itemToWire), ids));
    };

    if (needs.callIds.size > 0) {
      let conversations: Set<string>;
      if (scoped) {
        // The run's starts as the call index keeps them, so a page reads only
        // its own conversations' rows rather than every call the run made.
        conversations = conversationCallIds(
          await this.calls.callStartsOf(runId),
          needs.callIds,
        );
        add(
          (await this.itemDao.callRowsOf(runId, [...conversations], em)).map(
            itemToWire,
          ),
        );
      } else {
        const outside = (
          await this.itemDao.rowsOfKinds(
            runId,
            ['call_started', 'call_result'],
            callRange,
            em,
          )
        ).map(itemToWire);
        // The chains are read over EVERY start row the run has — the page's
        // own included — since a conversation can run through the page and
        // out of it on both sides.
        const starts = [...page, ...outside]
          .map(callStartOf)
          .filter((start) => start !== null);
        conversations = conversationCallIds(starts, needs.callIds);
        add(rowsOfCalls(outside, conversations));
      }
      // A call's pool hand-off names the member it now runs on, and a long
      // call's hand-off is routinely above the page.
      add(
        rowsOfCalls(
          (await this.itemDao.callHandOffRows(runId, callRange, em)).map(
            itemToWire,
          ),
          conversations,
        ),
      );
    }

    // Every declaration, not only the newest: the client merges them field by
    // field, last non-null winning, so a brief stated once early on would be
    // lost if only the latest row came along.
    await addById(['subagent_info'], needs.delegateIds, { outside: bounds });

    if (needs.workflowIds.size > 0) {
      // Over the page's announcements too: "the newest" is the newest of all of
      // them, and one above the page is never newer than the page's own.
      const outside = (
        await this.itemDao.rowsOfKinds(
          runId,
          ['workflow_info'],
          { outside: bounds },
          em,
        )
      ).map(itemToWire);
      add(workflowEdgeRows([...page, ...outside], needs.workflowIds));
    }

    await addById(['tool_call'], needs.toolCallIds, {
      before: bounds.firstSeq,
    });
    await addById(['tool_result'], needs.pendingResultIds, {
      after: bounds.lastSeq,
    });
    await addById(['tool_result'], needs.launchResultIds, { outside: bounds });

    return [...anchors.values()].sort((a, b) => a.seq - b.seq);
  }
}
