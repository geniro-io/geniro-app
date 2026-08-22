import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import {
  CHAT_TITLE_MAX_CHARS,
  CHAT_TITLE_UPGRADE_TURNS,
  SINGLE_AGENT_NODE,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { titleFromText } from '../utils/derive-title';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';

/**
 * Names a chat once its first turn has finished.
 *
 * An untitled run falls through to its agent kind in `runLabel`, so a chat that
 * is never named renders as the CLI that ran it.
 *
 * It SUBSCRIBES to the bus rather than being called from `ChatService`: the bus
 * is where a settled turn already announces itself, so nothing on the execution
 * path has to remember that titles exist. Unlike `v1/stats`' recorder, which
 * observes the same bus from another module, this one lives inside `v1/agents`
 * and writes the shared `runs` row — the decoupling here is from the CALLER, not
 * from the module.
 *
 * The title is asked of the CLI FIRST and derived only when it has none. That
 * order is the whole point — an agent that just read the exchange writes "Fix
 * conflicts worktree" where the host can only trim the user's opening line — and
 * the two shipped CLIs sit on opposite sides of it: cursor writes a generated
 * title into its own session store, while headless claude writes none at all
 * (measured; see `ClaudeAdapter`'s class doc).
 */
@Injectable()
export class ChatTitleService implements OnModuleInit {
  private readonly logger = new Logger(ChatTitleService.name);

  /**
   * Runs being named right now.
   *
   * A turn that settles twice — the CLI carrying on by itself after its result
   * line, which `handleBetweenTurnEvent` deliberately allows — would otherwise
   * start a second naming while the first is still reading the session store.
   * Cleared in a `finally`, so an entry cannot outlive the operation that made
   * it and there is no teardown path (run delete included) able to leak one.
   */
  private readonly naming = new Set<string>();

  /**
   * How many times each run has re-asked its CLI for a title it may since have
   * written — see {@link upgrade}.
   *
   * Unlike {@link naming} this one OUTLIVES the operation that writes it, so it
   * needs a teardown of its own: entries are dropped when the run is deleted,
   * on the bus announcement that exists for exactly this (`publishRunDeleted`).
   * A per-run map cleared only on the next turn's start is the shape that leaks
   * on delete, which the chat service has been bitten by before.
   */
  private readonly upgradesTried = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      // `nodeId` is the cheap half of the chat-run test and costs no query: the
      // chat path persists null, the graph executor persists a node's id.
      if (event.item.kind !== 'turn_complete' || event.item.nodeId !== null) {
        return;
      }
      // Fire-and-forget with the failure OWNED here, exactly as the usage
      // recorder does: this is an RxJS subscriber, so a rejection escaping it
      // would surface as an unhandled rejection and reach the process-level
      // crash guard. An unnamed chat must not be able to take the daemon's turn
      // plumbing with it.
      void this.name(event.runId).catch((err) => {
        this.logger.warn(
          `failed to name run ${event.runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });
    // Fired after the run's rows are gone, so nothing here can outlive what it
    // is keyed by.
    this.bus.allDeleted().subscribe((runId) => {
      this.upgradesTried.delete(runId);
    });
  }

  /**
   * Name an unnamed run, or upgrade a name this service itself derived.
   *
   * A user's rename is permanent, which is why the run row needs no companion
   * "who named this" column: every write is conditional on the title this call
   * READ still being there (`RunDao.retitle`), and the upgrade additionally
   * requires that title to be exactly what this service would derive today. A
   * rename stops matching on both counts, so nothing can overwrite it.
   */
  private async name(runId: string): Promise<void> {
    if (this.naming.has(runId)) {
      return;
    }
    this.naming.add(runId);
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (
        !run ||
        // A workflow run is labelled by its workflow, which `runLabel` already
        // falls back to — naming it after a node's opening prompt would replace
        // a true label with a worse one.
        run.workflowId !== null ||
        run.agentKind === null
      ) {
        return;
      }
      // Narrowed above; restated so the two paths need not re-check it.
      const named = run as Run & { agentKind: AgentKind };
      const title =
        run.title === null
          ? await this.resolve(named, em)
          : await this.upgrade(named, em);
      if (title === null) {
        return;
      }
      // Conditional at the SQL level, so the read above is an early exit rather
      // than the decision: resolving a title is several reads long, and a rename
      // landing inside that window must win.
      if (!(await this.runDao.retitle(runId, title, run.title, em))) {
        return;
      }
      // Status and activity are both OMITTED rather than nulled: this announce
      // read neither, and `null` is an assertion in both fields — it would put
      // the badge back to a status nothing checked and clear the activity
      // phrase of a turn that may already be running again.
      this.bus.publishRunStatus({ runId, status: null, title });
    } finally {
      this.naming.delete(runId);
    }
  }

  /**
   * The agent's own title for a run this service already named, or null when
   * there is nothing better to write.
   *
   * It exists because cursor names a conversation only AFTER an exchange: the
   * first turn's read routinely finds nothing, so the derived title is written
   * and — named once — the agent's better one would never land on a chat started
   * in this app, only on an imported one.
   *
   * Two things bound it, because this runs on every settled turn. The adapter is
   * asked FIRST and a null ends the attempt before any transcript read — which
   * is the whole cost for claude, whose base implementation answers null without
   * touching disk. And the attempts are counted per run
   * ({@link CHAT_TITLE_UPGRADE_TURNS}), so a conversation that is never going to
   * be named stops being asked instead of paying a read per turn forever.
   */
  private async upgrade(
    run: Run & { agentKind: AgentKind },
    em: EntityManager,
  ): Promise<string | null> {
    const tried = this.upgradesTried.get(run.id) ?? 0;
    if (tried >= CHAT_TITLE_UPGRADE_TURNS) {
      return null;
    }
    this.upgradesTried.set(run.id, tried + 1);
    const native = await this.readNativeTitle(run, em);
    if (native === null) {
      return null;
    }
    const candidate = titleFromText(native, CHAT_TITLE_MAX_CHARS);
    if (candidate === '' || candidate === run.title) {
      // Already the agent's own name — stop asking rather than re-reading its
      // store for the rest of the conversation.
      this.upgradesTried.set(run.id, CHAT_TITLE_UPGRADE_TURNS);
      return null;
    }
    // The title must still be the one this service derived. Anything else is
    // the user's, and a name they chose outranks the agent's.
    const opening = await this.itemDao.firstUserMessageText(run.id, em);
    const derived =
      opening === null ? null : titleFromText(opening, CHAT_TITLE_MAX_CHARS);
    if (derived === null || derived !== run.title) {
      this.upgradesTried.set(run.id, CHAT_TITLE_UPGRADE_TURNS);
      return null;
    }
    this.upgradesTried.set(run.id, CHAT_TITLE_UPGRADE_TURNS);
    return candidate;
  }

  /** The CLI's own title, else one derived from the opening message. */
  private async resolve(
    run: Run & { agentKind: AgentKind },
    em: EntityManager,
  ): Promise<string | null> {
    const native = await this.readNativeTitle(run, em);
    const text =
      native ?? (await this.itemDao.firstUserMessageText(run.id, em));
    if (text === null) {
      return null;
    }
    const title = titleFromText(text, CHAT_TITLE_MAX_CHARS);
    return title === '' ? null : title;
  }

  /**
   * What the CLI called this conversation, or null when it has no name for it.
   *
   * Every failure here is a null and a log line. A CLI that cannot be read is a
   * chat that gets the derived title, which is the same outcome as a CLI that
   * simply has no title — so nothing the user sees depends on telling them
   * apart.
   */
  private async readNativeTitle(
    run: Run & { agentKind: AgentKind },
    em: EntityManager,
  ): Promise<string | null> {
    try {
      const state = await this.nodeStateDao.getByRunNode(
        run.id,
        SINGLE_AGENT_NODE,
        em,
      );
      const sessionId = state?.agentSessionId ?? null;
      // Before the CLI has named a session there is nothing to read, and the
      // first turn of a brand-new chat is exactly that case.
      return sessionId === null
        ? null
        : await this.adapters.for(run.agentKind).readSessionTitle(sessionId);
    } catch (err) {
      this.logger.warn(
        `session title lookup for run ${run.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}
