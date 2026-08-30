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
   * Every OTHER model setting this run's next turn asks for, as a JSON object
   * of `{parameterId: value}` — `{"optimize_for":"intelligence"}`.
   *
   * ONE column rather than one per axis, and that is the point of it: the ids
   * belong to the CLI, not to this app (measured on cursor — `optimize_for`,
   * `thinking`, `fast`, and whichever it adds next), so a column per axis would
   * mean a schema change every time another product ships a setting. `effort`
   * and `contextWindow` keep theirs because those two have a control, a
   * vocabulary endpoint and a meaning geniro states in its own words.
   *
   * TEXT holding JSON rather than a `json` column, for the reason the two above
   * are TEXT: the `safe: true` schema sync adds it additively, no migration.
   * Read and written only through `utils/model-parameters.ts`.
   */
  @Property({ type: 'text', nullable: true })
  modelParameters: string | null = null;

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
   * The last reading taken from this run's own agent process before it was
   * closed — the context breakdown and the plan limits, as JSON, with the
   * moment and the transcript position they were taken at.
   *
   * Both figures are answerable only by a RUNNING agent (claude asks its live
   * stdin dialogue), so a chat whose process has been reaped for idleness had
   * nothing to show at all — which is the reported "wrong popup withoput data".
   * The reading is taken on the way out (`AgentSessionRegistry.onIdleFarewell`)
   * and served while no process exists, labelled with when it was taken.
   *
   * TEXT and opaque here: the shape belongs to `ChatMetricsService`, which
   * parses it through the same schemas the wire uses and discards a reading it
   * can no longer read. `atSeq` is what keeps it honest — a transcript that has
   * moved since makes the figures describe a conversation that no longer
   * exists, and they are dropped rather than shown with a timestamp nobody
   * reads.
   */
  @Property({ type: 'text', nullable: true })
  lastMetricsReading: string | null = null;

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
   * Whether this run's cursor turns ask for **Max Mode** — the window every
   * model that carries no `context` parameter of its own runs at.
   *
   * A SNAPSHOT of the user's setting, taken when the run is created, on the
   * same terms as {@link customInstructions} above: flipping the switch
   * changes the next chat rather than the one already open, so a conversation
   * runs at the window it was started at for its whole life. The alternative —
   * a live read — would silently move a thread between a 200k and a 1M window
   * between two messages, which is the one thing a context meter must not do.
   *
   * NULL means "this run predates the setting", and the adapter reads that as
   * the default rather than as OFF: every run created before it was stored ran
   * with Max Mode on, and reading their absence as a `false` would quietly
   * shrink every existing cursor conversation's window.
   *
   * `boolean` rather than `text`, and nullable, so the `safe: true` schema
   * sync adds the column additively with no migration.
   */
  @Property({ type: 'boolean', nullable: true })
  cursorMaxMode: boolean | null = null;

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

  /**
   * A summary of everything this conversation held BEFORE geniro compacted it,
   * waiting to be handed to the next turn — null whenever nothing is owed.
   *
   * Only a CLI whose compaction geniro performs itself
   * (`AgentGeniroCommand.replacesSession`) ever writes here. Such a compaction
   * drops the agent's own session, which is the entire point and also the
   * entire risk: the new session starts knowing nothing, so the summary the
   * compaction just produced is the ONLY thing standing between the user and a
   * conversation that has forgotten itself. It is therefore durable rather than
   * held in memory — a daemon restarted between the compaction and the next
   * message would otherwise lose exactly the thing the compaction was for.
   *
   * Consumed once: the next turn prepends it and clears the column in the same
   * write, so it cannot ride a second prompt. A CLI that compacts its own
   * history never touches this, and neither does a workflow run.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration.
   */
  @Property({ type: 'text', nullable: true })
  pendingContext: string | null = null;

  /**
   * The pull requests this run opened, as a JSON array of
   * `{owner, repo, number, url, seq}` — see `agents/utils/pull-request-capture.ts`.
   *
   * On the RUN because it is the only place the answer survives: the pull
   * request is opened by the agent's own `gh` in a checkout that then moves on,
   * and often in a sibling repository the run's `cwd` never names. The
   * transcript holds the evidence, but re-deriving it on every read means
   * scanning the whole conversation (14k items on a real thread here), so it is
   * scanned once and kept.
   *
   * TEXT so the `safe: true` schema sync adds it additively, no migration —
   * the same rule {@link pendingContext} follows.
   */
  @Property({ type: 'text', nullable: true })
  pullRequests: string | null = null;

  /**
   * How far {@link pullRequests} has been scanned — the highest item `seq` the
   * capture pass has looked at, or null when it never ran.
   *
   * This is what makes the scan INCREMENTAL and the backfill free: a run whose
   * marker is null is scanned whole (recovering every pull request opened
   * before this feature existed), and after that each pass only reads items
   * newer than the marker, which the `(run_id, seq)` index serves directly.
   *
   * NULL rather than -1 as the "never scanned" value: a run genuinely scanned
   * when it had no items records -1, and the two mean different things to a
   * later pass that has to decide whether history still needs recovering.
   */
  @Property({ type: 'integer', nullable: true })
  pullRequestsScannedSeq: number | null = null;
}
