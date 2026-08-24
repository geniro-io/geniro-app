import { randomUUID } from 'node:crypto';

import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { ChatApprovalMode } from '../../agents/chat.types';
import type { AgentKind, RunStatus } from '../runs.types';

/** One execution of a workflow (graph) or a single-agent chat. */
@Entity({ tableName: 'runs' })
export class Run extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** Workflow (graph) id this run executed; null for an ad-hoc single agent. */
  @Property({ type: 'string', nullable: true })
  workflowId: string | null = null;

  @Property({ type: 'string' })
  status: RunStatus = 'pending';

  @Property({ type: 'string', nullable: true })
  title: string | null = null;

  /**
   * Working directory for a single-agent chat run — the user's chosen project
   * folder, which the adapter spawns the CLI in. Null for graph runs. The
   * daemon validates this path before spawning so the headless agent is scoped
   * to the user's project and never the daemon's own cwd (the app repo).
   */
  @Property({ type: 'string', nullable: true })
  cwd: string | null = null;

  /** Which CLI agent drives a single-agent chat run; null for graph runs. */
  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  /** Model alias for a single-agent run; null = adapter default. */
  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  /**
   * Chat approval mode for a single-agent run; null for graph runs (their
   * modes live in the workflow YAML) and for legacy chat rows created before
   * the selector existed — null keeps the exact pre-selector behavior (no
   * permission flags on the CLI). Plain TEXT so the `safe: true` schema sync
   * adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  approval: ChatApprovalMode | null = null;

  /**
   * Reasoning effort for a single-agent run's next turn, spelled as its CLI
   * spells it; null = the CLI's own default (no `--effort` flag), which is
   * also every row that predates the chip and every CLI without the control.
   * A plain string, not an enum: the vocabulary is the adapter's, and the
   * value is validated by `EffortsService.accepts` before it lands — against
   * `AgentAdapter.listEfforts()` only for a CLI whose list is the whole
   * vocabulary, since one whose levels belong to the MODEL has a union there.
   * TEXT so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  effort: string | null = null;

  /**
   * Which of the model's context-window sizes this run's next turn asks for,
   * spelled as its CLI spells it (`300k`, `1m`); null = the model's own
   * default, which is also every row predating the chip and every CLI with no
   * such control.
   *
   * A plain string for the reason `effort` is one, and NOT validated up front
   * for the reason it partly is: the sizes belong to the MODEL, so there is no
   * CLI-wide list to check against — a value the chosen model does not offer is
   * reported by the turn's own driver, against the live agent.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  contextWindow: string | null = null;

  /**
   * How full this conversation's context window was the LAST time the CLI said
   * — the durable half of the composer's ring, and the only half a window that
   * has just loaded has.
   *
   * Runtime state, not a setting: written from every `context_progress` the CLI
   * reports, which is once per main-thread model response, so it tracks a
   * running turn rather than a finished one. That is the whole reason it exists.
   * The transcript already carries a figure per SETTLED turn, and on the work
   * this app is for a turn runs for an hour and grows the window by half a
   * million tokens — so a client with no live reading (a reload, a reconnect, a
   * chat opened for the first time this session) drew the ring from a figure
   * that could be a whole turn old. Worst directly after a `/compact`, which is
   * where it was REPORTED: the last settled turn said 16.7k of 1M and the panel
   * beside the ring, which asks the live agent, said 462.3k.
   *
   * INTEGER so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'integer', nullable: true })
  contextTokens: number | null = null;

  /**
   * The window {@link contextTokens} is measured against, as the CLI reported
   * it — null until one has been reported.
   *
   * Never overwritten with null, on the rule the renderer's own fold follows: a
   * turn that reports no window has said nothing about the model's, and wiping
   * a real denominator leaves a numerator with nothing to divide by.
   */
  @Property({ type: 'integer', nullable: true })
  contextWindowTokens: number | null = null;

  /**
   * Plugin directory a single-agent run's turns load, CANONICAL (the path
   * `resolveValidConfigDir` returned when the chat was created); null = none,
   * which is every row predating the chip and every CLI with no plugin
   * mechanism. A graph run's plugin directories live per node in the workflow
   * YAML instead.
   *
   * Part of the run's IDENTITY, like `cwd`, rather than a per-turn setting: it
   * is chosen once when the chat is created and the settings PATCH does not
   * carry it. TEXT so the `safe: true` schema sync adds it additively.
   */
  @Property({ type: 'string', nullable: true })
  configDir: string | null = null;

  /**
   * The user's global custom instructions AS THEY STOOD when this run was
   * created; null when they had typed none, and for every row predating the
   * setting.
   *
   * A SNAPSHOT rather than a live read of `settings.json`, and the difference
   * is visible to the user: editing the box changes the next chat, never the
   * one already open. That is the deliberate half — `AgentAdapter.sessionKey`
   * hashes this value, so a live read would invalidate the kept CLI process
   * mid-conversation and respawn it, taking the user's MCP servers (and
   * whatever one of them owns, up to a browser they are logged into) down
   * between two messages.
   *
   * Part of the run's IDENTITY like `configDir` above, so the settings PATCH
   * does not carry it either. TEXT so the `safe: true` schema sync adds it
   * additively, no migration.
   */
  @Property({ type: 'text', nullable: true })
  customInstructions: string | null = null;

  /**
   * The sidebar group this run is filed under ({@link RunGroup.id}), or null
   * for one sitting loose at the bottom of the list.
   *
   * A plain id column rather than a MikroORM relation, the same shape
   * `workflowId` uses: the group owns nothing about the run, and the direction
   * that matters is the one this column already expresses. Deleting a group
   * nulls this on its runs (`RunDao.clearGroup`) instead of cascading, because
   * a folder disappearing must never take a conversation with it. TEXT so the
   * `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'string', nullable: true })
  groupId: string | null = null;
}
