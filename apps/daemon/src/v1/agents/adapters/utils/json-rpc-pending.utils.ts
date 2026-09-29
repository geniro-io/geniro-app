import { encodeRequest, type JsonRpcId } from './json-rpc.utils';

/** One request awaiting its reply, and who is owed it. */
export interface PendingRequest<K extends string, T> {
  kind: K;
  /** The turn that sent the frame. */
  turn: T;
  /**
   * What the sender wants said about this frame if its reply is a refusal, or
   * null when the frame has nothing of its own to add.
   */
  detail: string | null;
}

/**
 * The JSON-RPC requests one client process has sent and is still waiting on:
 * the id counter, the map from id to sender, and the rule for a reply that
 * arrives late. Shared by every protocol driven this way (ACP, codex's
 * app-server), each of which layers what is its own — ACP's reply deadlines —
 * on top.
 *
 * A session outlives its turns, so each entry remembers WHICH turn sent it: a
 * reply owed to a turn that has since ended must never be handed to the turn
 * that replaced it. Doing so would apply turn 1's answer — a refused model, a
 * released prompt hold — to turn 2's conversation.
 */
export class PendingRequests<K extends string, T> {
  private nextId = 1;
  private readonly entries = new Map<JsonRpcId, PendingRequest<K, T>>();

  constructor(
    /** Names the protocol in the log line for a dropped reply. */
    private readonly protocol: string,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Number a request, remember it against `turn`, and hand its frame to
   * `write`. The id it went out under, or null — with nothing left registered —
   * when `write` reports the frame did not land. The id is spent either way, so
   * one never names two frames.
   */
  send(
    method: string,
    params: unknown,
    kind: K,
    turn: T,
    write: (frame: string) => boolean,
    detail: string | null = null,
  ): JsonRpcId | null {
    const id = this.nextId++;
    this.entries.set(id, { kind, turn, detail });
    if (!write(encodeRequest(id, method, params))) {
      this.entries.delete(id);
      return null;
    }
    return id;
  }

  /**
   * A request frame for the CALLER to write, registered first so that the reply
   * to it is recognised.
   */
  frame(method: string, params: unknown, kind: K, turn: T): string {
    const id = this.nextId++;
    this.entries.set(id, { kind, turn, detail: null });
    return encodeRequest(id, method, params);
  }

  /**
   * The entry a reply is owed to, removed as it is taken; null when nothing here
   * is owed one.
   *
   * A reply owed to a turn other than `current` is dropped and logged, unless
   * `deliverStale` says that kind's reply still means something to whoever
   * reads it — a refusal the user has to hear about, whichever turn is open by
   * the time it arrives.
   */
  take(
    id: JsonRpcId,
    current: T,
    deliverStale?: (kind: K) => boolean,
  ): PendingRequest<K, T> | null {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return null;
    }
    this.entries.delete(id);
    if (entry.turn !== current && deliverStale?.(entry.kind) !== true) {
      this.log(
        `${this.protocol}: dropped the reply to request ${String(id)} (${entry.kind}) — the turn that sent it has already ended`,
      );
      return null;
    }
    return entry;
  }
}
