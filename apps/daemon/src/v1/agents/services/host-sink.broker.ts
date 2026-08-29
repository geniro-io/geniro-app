import { Logger } from '@nestjs/common';

/**
 * The outcome every host tool answers with when its call could not be
 * delivered — the one member each of their outcome unions shares.
 *
 * Named here rather than restated per tool because {@link HostSinkBroker.deliver}
 * is what produces it: a tool declares the SHAPES it can succeed with, and the
 * failure half is the broker's to say.
 */
export interface HostSinkUnavailable {
  status: 'unavailable';
  reason: string;
}

/**
 * The rendezvous behind every one of geniro's OWN tools — the half that is the
 * same for all of them.
 *
 * A host tool always has two ends in different modules: the MCP endpoint knows
 * how to receive the call (`McpServerService`), and the turn that owns the run
 * knows how to act on it — put a card on screen, allocate a seq, persist an
 * item. Whoever runs the turn installs a sink for the length of that turn; the
 * tool looks one up. Nothing in here writes a row, tracks an approval or
 * touches the event bus: doing any of that would make this a SECOND producer of
 * the same transcript row, free to disagree with the one seam every other row
 * goes through.
 *
 * In memory and per LAUNCH, deliberately. A sink closes over a live turn — its
 * seq allocator, its parked promises — so an entry that outlived the turn would
 * file rows against a conversation nothing is watching, or be answered into
 * nothing.
 *
 * Subclasses add only what is genuinely per-tool: the public verb (`canAsk` /
 * `ask`, `canReport` / `report`), the sentence said when no turn is running, and
 * the sink's own signature. Extracted at the THIRD tool rather than the second —
 * the identity-checked disposer and the never-throwing delivery below are both
 * subtle enough that a third hand-written copy was the real risk.
 */
export abstract class HostSinkBroker<TSink> {
  /**
   * Named for the concrete subclass, so a log line still says which tool failed
   * without every subclass declaring its own logger.
   */
  private readonly logger = new Logger(this.constructor.name);
  private readonly sinks = new Map<string, TSink>();

  private key(runId: string, nodeId: string): string {
    return `${runId}::${nodeId}`;
  }

  /**
   * Install the sink for one node's turn; the returned disposer removes it.
   *
   * A disposer rather than a keyed `unregister(runId, nodeId)`, and the
   * distinction is load-bearing: settle paths run late and out of order, so a
   * keyed removal would silently tear down the sink a LATER turn of the same run
   * had already installed. The identity check is what makes a stale disposer a
   * no-op instead.
   */
  register(runId: string, nodeId: string, sink: TSink): () => void {
    const key = this.key(runId, nodeId);
    this.sinks.set(key, sink);
    return () => {
      if (this.sinks.get(key) === sink) {
        this.sinks.delete(key);
      }
    };
  }

  /**
   * Whether this node currently has a sink — what every subclass's `canX` gate
   * answers, and what gates the TOOL LISTING, so an agent is never offered a
   * tool whose output nobody would receive.
   */
  protected has(runId: string, nodeId: string): boolean {
    return this.sinks.has(this.key(runId, nodeId));
  }

  /**
   * Hand the call to this node's sink and resolve with what happened.
   *
   * Never throws, which is the whole contract: a call that cannot be delivered
   * is an OUTCOME the agent reads and carries on from — it still holds the data
   * and can write it into its reply — where a throw would cross the MCP
   * transport as a tool error and read to the model as its own call being
   * malformed.
   *
   * @param absent what to say when no turn is running — phrased per tool,
   *   because "nobody could record them" and "nobody could put this on screen"
   *   suggest different next moves to the agent reading it.
   * @param failure the verb phrase for the log line (`could not <failure>`).
   */
  protected async deliver<TOutcome>(
    runId: string,
    nodeId: string,
    absent: string,
    failure: string,
    call: (sink: TSink) => Promise<TOutcome>,
  ): Promise<TOutcome | HostSinkUnavailable> {
    const sink = this.sinks.get(this.key(runId, nodeId));
    if (!sink) {
      return { status: 'unavailable', reason: absent };
    }
    try {
      return await call(sink);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `run ${runId}/${nodeId} could not ${failure}: ${message}`,
      );
      return { status: 'unavailable', reason: message };
    }
  }
}
