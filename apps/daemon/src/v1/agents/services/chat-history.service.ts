import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import type {
  ChatHistoryWire,
  HistoryWindow,
  ItemWire,
  SeqRange,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
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
  ) {}

  async read(
    runId: string,
    afterSeq = -1,
    window?: HistoryWindow,
  ): Promise<ChatHistoryWire> {
    const items = await this.chats.getHistory(runId, afterSeq, window);
    // A full page asked with a probe carries one row the client will drop; its
    // anchors would draw a card with no row of the window behind it.
    const kept =
      window?.probe === true && items.length === window.limit
        ? window.take === 'oldest'
          ? items.slice(0, -1)
          : items.slice(1)
        : items;
    return { items, anchors: await this.anchorsFor(runId, kept) };
  }

  async anchorsFor(
    runId: string,
    page: readonly ItemWire[],
  ): Promise<ItemWire[]> {
    const bounds = pageBoundsOf(page);
    if (bounds === null) {
      return [];
    }
    const needs = anchorNeedsOf(page);
    const em = this.em.fork();
    const anchors = new Map<string, ItemWire>();
    const add = (rows: readonly ItemWire[]): void => {
      for (const row of rows) {
        if (isOutside(row.seq, bounds)) {
          anchors.set(row.id, row);
        }
      }
    };
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
      const outside = (
        await this.itemDao.rowsOfKinds(
          runId,
          ['call_started', 'call_result'],
          { outside: bounds },
          em,
        )
      ).map(itemToWire);
      // The chains are read over EVERY start row the run has — the page's own
      // included — since a conversation can run through the page and out of it
      // on both sides.
      const starts = [...page, ...outside]
        .map(callStartOf)
        .filter((start) => start !== null);
      add(rowsOfCalls(outside, conversationCallIds(starts, needs.callIds)));
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
