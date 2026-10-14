import type { Item } from '../../runs/entity/item.entity';
import type { ItemWire } from '../chat.types';
import { OUTSIDE_ANY_CALL } from './call-membership';
import { parseJsonColumn } from './json-util';

/**
 * A stored row as the wire carries it — `payload` parsed back from its JSON
 * text, so the renderer receives structured data rather than a doubly-encoded
 * string. The one projection every route serving transcript rows goes through,
 * so a page and the rows it is anchored by cannot differ in shape.
 */
export function itemToWire(item: Item): ItemWire {
  return {
    id: item.id,
    runId: item.runId,
    nodeId: item.nodeId,
    seq: item.seq,
    kind: item.kind,
    role: item.role,
    payload: parseJsonColumn(item.payload),
    createdAt: item.createdAt.toISOString(),
    inCall: inCallWire(item.inCall),
  };
}

/** `Item.inCall` as the wire states it: absent while unstamped, null outside every call. */
export function inCallWire(inCall: string | null): string | null | undefined {
  if (inCall === null) {
    return undefined;
  }
  return inCall === OUTSIDE_ANY_CALL ? null : inCall;
}
