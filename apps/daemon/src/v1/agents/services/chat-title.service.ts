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
 * Names a chat from its first message, then improves the name once the CLI has
 * one of its own.
 *
 * An untitled run falls through to its agent kind in `runLabel`, so a chat that
 * is not named YET renders as the CLI that ran it — which is what naming on
 * `turn_complete` alone left on screen for the whole of a first turn.
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
 * conflicts worktree" where the host can only trim the user's opening line.
 *
 * The two shipped CLIs reach an agent-written title by opposite routes, and
 * neither can serve the other's. cursor WRITES one into its own session store,
 * so it is read for free. Headless claude writes none anywhere (measured; see
 * `ClaudeAdapter`'s class doc), so it is ASKED — a throwaway turn on a cheap
 * model, once per conversation. Without that ask, a chat opened with a pasted
 * URL was named after that URL for the rest of its life, which is what got
 * REPORTED.
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

  /**
   * How many times each run's CLI has been ASKED for a title — see
   * {@link askForTitle}.
   *
   * Separate from {@link upgradesTried} because the two bound different costs,
   * and torn down beside it on the same delete announcement.
   *
   * A COUNT rather than a set, which is a correction. Asking was one-shot, on
   * the reading that "a title is as good as it will get on the first try" —
   * measured false: an opening that is a bare link or a slash command has
   * nothing nameable in it, so the first ask can only be declined, and the
   * chat then wore its opening line for good. That is the reported "we fixed
   * it twice and the new title still is not set". A later ask is a different
   * question because it carries what the conversation has SINCE said
   * ({@link AgentTitleInput.latest}), and it is bounded by the same turn
   * budget the read path uses, so a chat nobody can name still stops costing
   * a spawn.
   */
  private readonly generationTried = new Map<string, number>();

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
      if (event.item.nodeId !== null) {
        return;
      }
      // The user's OWN message names the chat at once, without waiting for the
      // turn to end.
      //
      // REPORTED as "AutoTitle не работает — он просто название агента сейчас
      // выводит", with a screenshot of a sidebar row reading `claude` under a
      // turn that was still running. Nothing was broken: an untitled run falls
      // through to its agent kind, and the naming fired on `turn_complete` — so
      // every new chat was labelled after its CLI for the whole of its first
      // turn, which is minutes on the work this app is for, and is exactly the
      // stretch a user is watching the sidebar to find it in.
      //
      // The later pass is unchanged and still does the interesting half: this
      // one can only trim the opening line, while `upgrade` replaces it with
      // the name the AGENT gave the conversation once there is one.
      if (event.item.kind === 'message' && event.item.role === 'user') {
        void this.name(event.runId, true).catch((err) => {
          this.logger.warn(
            `failed to name run ${event.runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        return;
      }
      if (event.item.kind !== 'turn_complete') {
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
      this.generationTried.delete(runId);
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
  private async name(runId: string, unnamedOnly = false): Promise<void> {
    if (this.naming.has(runId)) {
      return;
    }
    this.naming.add(runId);
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      // The message path names an UNNAMED run and stops there. Letting it reach
      // `upgrade` would spend that run's few attempts — and a session read
      // apiece — on every message the user ever sends, to ask a question only a
      // finished turn can have changed the answer to.
      if (unnamedOnly && run?.title !== null) {
        return;
      }
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
   * Two CLIs reach an agent-written title by opposite routes and both end here.
   * cursor names a conversation only AFTER an exchange, so the first turn's READ
   * finds nothing and — named once — its better title would otherwise never land
   * on a chat started in this app. claude writes no title anywhere headlessly,
   * so there is nothing to read at all and it is ASKED instead
   * ({@link AgentAdapter.generateTitle}).
   *
   * The ownership check comes FIRST, before either route. It used to sit last,
   * on the reasoning that the adapter's answer was the cheap half — true while
   * every adapter answered null off memory, and false the moment one of them
   * spends a model call. One indexed query is now what stands between a renamed
   * chat and a spawn that could not have been used anyway.
   *
   * Two budgets, because the two routes cost different things. Reading is
   * counted per run ({@link CHAT_TITLE_UPGRADE_TURNS}), so a conversation the
   * agent is never going to name stops being asked. Asking happens at most ONCE
   * per run: a title is as good as it will get on the first try, and a failure
   * (a timeout, a refused model) that retried per turn would spawn a process per
   * turn for the life of the chat. They are separate sets precisely so a CLI
   * that generates nothing — where a null means "no such mechanism" rather than
   * "it did not work" — keeps its full read budget.
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
    // The title must still be the one this service derived. Anything else is
    // the user's, and a name they chose outranks the agent's.
    const opening = await this.itemDao.firstUserMessageText(run.id, em);
    if (
      opening === null ||
      titleFromText(opening, CHAT_TITLE_MAX_CHARS) !== run.title
    ) {
      this.upgradesTried.set(run.id, CHAT_TITLE_UPGRADE_TURNS);
      return null;
    }
    const better =
      (await this.readNativeTitle(run, em)) ??
      (await this.askForTitle(run, em, opening));
    if (better === null) {
      return null;
    }
    // Whatever the route, this run is done being asked: a read that answered is
    // the agent's own name, and an ask is one-shot by construction.
    this.upgradesTried.set(run.id, CHAT_TITLE_UPGRADE_TURNS);
    const candidate = titleFromText(better, CHAT_TITLE_MAX_CHARS);
    return candidate === '' || candidate === run.title ? null : candidate;
  }

  /**
   * The title this run's CLI writes when ASKED — for the CLI that keeps none of
   * its own. Null once this run has already asked, whatever came back.
   *
   * The exchange is read here rather than in the adapter, which must not touch
   * this app's database: the opening message is already in hand from the
   * ownership check above, and the agent's first reply is fetched only on the
   * one turn that asks.
   *
   * Every failure is a null and a log line, on the same terms as
   * {@link readNativeTitle}: the derived title is already on screen and correct,
   * so a CLI that could not be asked costs a better name and nothing else.
   */
  private async askForTitle(
    run: Run & { agentKind: AgentKind },
    em: EntityManager,
    opening: string,
  ): Promise<string | null> {
    const asked = this.generationTried.get(run.id) ?? 0;
    if (asked >= CHAT_TITLE_UPGRADE_TURNS) {
      return null;
    }
    this.generationTried.set(run.id, asked + 1);
    try {
      // The newest exchange only from the SECOND ask on: on the first there is
      // nothing later than the opening, and repeating it would spend prompt on
      // the same two messages under a second heading.
      const latest = asked === 0 ? null : await this.latestExchange(run.id, em);
      const title = await this.adapters.for(run.agentKind).generateTitle({
        opening,
        reply: await this.itemDao.firstAssistantMessageText(run.id, em),
        latest,
        configDir: run.configDir,
      });
      if (title === null) {
        // SAID OUT LOUD, because until now it was not. An adapter answering
        // null — the CLI could not be run, its reply would not parse, or the
        // model declined to name the conversation — left no trace anywhere,
        // so a chat stuck on its opening line was indistinguishable from one
        // this service had never looked at. That silence is why the defect
        // survived two fixes.
        this.logger.debug(
          `run ${run.id}: ${run.agentKind} produced no title on ask ${asked + 1}`,
        );
      }
      return title;
    } catch (err) {
      this.logger.warn(
        `title generation for run ${run.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * What this conversation has been about lately, as one block — or null when
   * it has said nothing beyond its opening exchange.
   *
   * Both ends of the newest exchange, because either alone is routinely
   * unnameable: the user's last message can be "yes, do that" and the agent's
   * can be a paragraph of results with no statement of the task.
   */
  private async latestExchange(
    runId: string,
    em: EntityManager,
  ): Promise<string | null> {
    const [user, agent] = await Promise.all([
      this.itemDao.lastUserMessageText(runId, em),
      this.itemDao.lastAssistantMessageText(runId, em),
    ]);
    const block = [user, agent]
      .filter((text): text is string => text !== null && text.trim() !== '')
      .join('\n\n');
    return block === '' ? null : block;
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
