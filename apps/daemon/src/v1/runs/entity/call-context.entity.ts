import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * One agent-to-agent CALL's context reading (composite PK: runId + callId).
 *
 * The per-call twin of `NodeState`'s context pair, and the node is the wrong
 * grain for it: a node can hold several calls at once, each its own
 * conversation against its own window, while `node_state` is keyed
 * (runId, nodeId) — so two concurrent call threads on one node overwrite each
 * other's reading and the card can only ever show whichever wrote last.
 *
 * `callId` is its own COLUMN rather than a component of a joined key. The live
 * plane spells its owner key `<nodeId>::<callId>` because it needs one string;
 * a durable identity has no such constraint, and a composite built by joining
 * free-form parts is a collision this repo has already found at three sites.
 */
@Entity({ tableName: 'call_context' })
export class CallContext extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  callId!: string;

  /**
   * The node that RAN this call. A call is addressed by its id alone
   * everywhere else; this column exists so "this node's call threads" is a
   * query rather than a join through the transcript.
   */
  @Property({ type: 'string' })
  nodeId!: string;

  /**
   * The per-call twin of `NodeState`'s context pair. `CallContextDao` owns the
   * rules these are written under.
   */
  @Property({ type: 'integer', nullable: true })
  contextTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  contextWindowTokens: number | null = null;
}
