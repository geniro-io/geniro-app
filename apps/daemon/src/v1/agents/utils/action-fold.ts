import type { Item } from '../../runs/entity/item.entity';
import {
  type ActionOutcomePayload,
  ActionOutcomePayloadSchema,
  type ActionOutcomeState,
  ActionPayloadSchema,
  type LiveAction,
} from '../chat.types';
import { parseJsonColumn } from './json-util';

/**
 * An action's identity: the conversation that published it plus the id it
 * chose, so two agents of one run may both call a button `deploy`.
 */
export function actionKey(
  nodeId: string,
  conversationId: string,
  actionId: string,
): string {
  return `${nodeId}|${conversationId}|${actionId}`;
}

/** A press under way: the button shows a spinner and refuses another. */
const PENDING_STATES: ReadonlySet<ActionOutcomeState> = new Set([
  'pressed',
  'running',
]);
/**
 * Gone whatever `once` says.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/action-card.tsx (`RETIRING_STATES` /
 * `SUCCESS_STATES`), which reads the same states for the card's status line.
 */
const RETIRING_STATES: ReadonlySet<ActionOutcomeState> = new Set([
  'removed',
  'dismissed',
  'interrupted',
]);
/** A press that did what it promised — the end of a one-shot button. Same twin as above. */
const SUCCESS_STATES: ReadonlySet<ActionOutcomeState> = new Set([
  'succeeded',
  'stopped',
]);

export interface ActionFold {
  /** Still pressable, newest publish first. */
  live: LiveAction[];
  /** Every publish row's key, live or not — how a stale press is told apart from a gone one. */
  keyOfSeq: Map<number, string>;
}

/**
 * Folds a run's `action` and `action_outcome` rows, oldest first, into the
 * buttons still pressable. The newest publish of a key replaces the one before
 * it, and an outcome counts only against the publish it names: a press of a
 * button since republished says nothing about the new one.
 */
export function foldActions(
  rows: readonly Pick<Item, 'kind' | 'seq' | 'payload'>[],
): ActionFold {
  const byKey = new Map<string, LiveAction & { retired: boolean }>();
  const keyOfSeq = new Map<number, string>();
  for (const row of rows) {
    const payload = parseJsonColumn(row.payload);
    if (row.kind === 'action') {
      const parsed = ActionPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        continue;
      }
      const action = parsed.data;
      const key = actionKey(
        action.publisher.nodeId,
        action.publisher.conversationId,
        action.actionId,
      );
      keyOfSeq.set(row.seq, key);
      byKey.set(key, {
        seq: row.seq,
        actionId: action.actionId,
        nodeId: action.publisher.nodeId,
        conversationId: action.publisher.conversationId,
        label: action.label,
        ...(action.description === undefined
          ? {}
          : { description: action.description }),
        once: action.once,
        spec: action.spec,
        publisher: action.publisher,
        pending: false,
        retired: false,
      });
      continue;
    }
    if (row.kind !== 'action_outcome') {
      continue;
    }
    const parsed = ActionOutcomePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      continue;
    }
    const outcome: ActionOutcomePayload = parsed.data;
    const entry = byKey.get(
      actionKey(outcome.nodeId, outcome.conversationId, outcome.actionId),
    );
    if (entry === undefined || entry.seq !== outcome.actionSeq) {
      continue;
    }
    entry.lastOutcome = outcome;
    entry.pending = PENDING_STATES.has(outcome.state);
    entry.retired =
      RETIRING_STATES.has(outcome.state) ||
      (entry.once && SUCCESS_STATES.has(outcome.state));
  }
  const live: LiveAction[] = [];
  for (const { retired, ...action } of byKey.values()) {
    if (!retired) {
      live.push(action);
    }
  }
  live.sort((a, b) => b.seq - a.seq);
  return { live, keyOfSeq };
}
