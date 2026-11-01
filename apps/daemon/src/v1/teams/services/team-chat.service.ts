import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { RunWire } from '../../agents/chat.types';
import { ChatService } from '../../agents/services/chat.service';
import { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import { MemoryService } from '../../memory/services/memory.service';
import type { StartTeamChatInput, Team } from '../teams.types';
import { composeTeamChatInstructions } from '../utils/team-chat-instructions';
import { TeamStoreService } from './team-store.service';

/** A run's cwd is stored canonicalized; the library path may not be. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The conversation behind the team builder's chat panel — the user
 * describing a change in prose to an agent that changes the team through
 * `save_team_change`.
 *
 * It starts an ORDINARY CHAT rather than a second execution path: the agent
 * reads the file and its sibling teams with its own file tools from a
 * working directory, which is exactly what a chat already is, and `ChatService`
 * gives each of its turns the save (`TeamBuilderBroker`). So this composes
 * `ChatService` the way `TaskRunsService`
 * does for a board card's worktree. That is also why the dependency points
 * this way — `TeamsModule` imports `AgentsModule`, never the reverse.
 *
 * What this service knows and a chat cannot is the SUBJECT: where the library
 * keeps its files, and what a team document may contain. Both reach the
 * agent as a brief on the run (`Run.teamInstructions`), pointing at a JSON
 * Schema the store writes beside the teams. `ChatService` re-composes it
 * before each turn through the source this service installs (`useTeamBrief`),
 * so an open conversation is never briefed on an older format.
 */
@Injectable()
export class TeamChatService implements OnModuleInit {
  /**
   * Opens in flight, keyed by team — a second ask joins the first instead
   * of racing it.
   *
   * `open` is get-or-create over two awaits, so two calls that arrive together
   * both find nothing and both create: the panel then has two conversations
   * for one team and shows whichever is newer, stranding the other. It is
   * not a hypothetical — React's development double-effect produces exactly
   * this pair, and it was measured doing so (two `Team: Review Team` runs
   * from one press).
   *
   * A promise rather than a lock, so the second caller gets the SAME answer
   * rather than a second read of it; the entry is dropped whichever way the
   * first settles, so a failure is retried rather than cached. It cannot help
   * two DAEMONS, which is what `findTeamChat` answering newest-first is
   * for — but there is only ever one daemon per userData dir.
   */
  private readonly opening = new Map<string, Promise<RunWire>>();

  private schemaPath: Promise<string> | undefined;

  constructor(
    private readonly store: TeamStoreService,
    private readonly chats: ChatService,
    private readonly analyses: ThreadAnalysisService,
    private readonly memory: MemoryService,
  ) {}

  onModuleInit(): void {
    this.chats.useTeamBrief((slug, cwd) => this.briefFor(slug, cwd));
  }

  /**
   * The brief a chat editing `slug` from `cwd` is given, composed from the
   * team as it stands. A file that no longer validates is still briefed, under
   * the name it states (its slug when even the YAML is broken): that is when
   * the agent is told to repair it.
   */
  private async briefFor(
    slug: string,
    cwd: string,
    team?: Team,
  ): Promise<string> {
    const location = this.store.locate(slug);
    return composeTeamChatInstructions({
      path: location.path,
      slug,
      name: team?.name ?? (await this.store.nameOf(slug)) ?? slug,
      schemaPath: await this.schemaReference(),
      memory: this.memory.enabled,
      inLibrary: canonical(cwd) === canonical(location.directory),
    });
  }

  /**
   * Written once per launch, since the schema only changes with the daemon,
   * and again whenever the file has gone since.
   */
  private async schemaReference(): Promise<string> {
    const written = this.schemaPath;
    if (written !== undefined) {
      const path = await written.catch(() => null);
      if (path !== null && existsSync(path)) {
        return path;
      }
    }
    this.schemaPath = this.store.writeSchemaReference();
    return this.schemaPath;
  }

  /**
   * The chat for one team: the one that already exists, or a new one.
   *
   * Get-or-create rather than create, because the panel is a place the user
   * comes BACK to — a second chat per press would leave the conversation they
   * had yesterday stranded behind a thread that knows nothing. The composer
   * settings therefore apply to a chat being created and are ignored for one
   * that already exists; changing the agent or model of an open conversation
   * is `PATCH /v1/chats/:runId`, exactly as it is on the chat screen.
   *
   * The team is READ first, so a slug naming nothing is the store's own
   * 404 rather than a chat pointed at a file that is not there.
   */
  open(slug: string, input: StartTeamChatInput): Promise<RunWire> {
    const inFlight = this.opening.get(slug);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const started = this.openOnce(slug, input).finally(() => {
      this.opening.delete(slug);
    });
    this.opening.set(slug, started);
    return started;
  }

  private async openOnce(
    slug: string,
    input: StartTeamChatInput,
  ): Promise<RunWire> {
    const { team } = await this.store.get(slug);
    const location = this.store.locate(slug);
    const existing = await this.chats.findTeamChat(slug);
    if (existing !== null) {
      // An open conversation is re-briefed rather than left on the text it was
      // created with — see `ChatService.refreshTeamInstructions`.
      await this.chats.refreshTeamInstructions(
        existing.id,
        await this.briefFor(slug, existing.cwd ?? location.directory, team),
      );
      return existing;
    }
    const teamInstructions = await this.briefFor(
      slug,
      location.directory,
      team,
    );
    return this.chats.createChat({
      ...input,
      // The dock's own default may be a mode this CLI does not offer.
      approval: this.chats.offeredApproval(input.agentKind, input.approval),
      // The LIBRARY directory, not the file: a cwd is a directory, and putting
      // the agent in the library is also what lets it read a sibling team
      // as an example. Which file is its own is the brief's job to say.
      cwd: location.directory,
      // Named at creation so the thread is findable in a sidebar listing every
      // other conversation — and so `ChatTitleService` leaves it alone, that
      // service only ever replacing a title it derived itself.
      title: `Team: ${team.name}`,
      editsTeamSlug: slug,
      teamInstructions,
    });
  }

  /**
   * **Destructive and irreversible**: throw away every chat about one
   * team — the panel's own "start over", for a conversation that has gone
   * wrong.
   *
   * Takes a raw slug and reads no team, so {@link deleteTeam} can call
   * it once the file is already gone.
   */
  discard(slug: string): Promise<{ deleted: number }> {
    return this.chats.deleteTeamChats(slug);
  }

  /**
   * **Destructive and irreversible**: delete a team and every chat about
   * it — its builder chats and its analyses.
   *
   * A chat whose only subject is a file that no longer exists has nothing left
   * to talk about — and its agent still carries a brief naming that file, so
   * leaving it behind means a thread that answers every message about a
   * team it cannot read. This is the one way these runs differ from a
   * board task's, where the conversation deliberately outlives the card.
   *
   * The cascade lives HERE rather than on the store for two reasons that point
   * the same way: `TeamStoreService` is a plain file store built from an
   * options bag with no DI at all, so it cannot reach a chat; and the route
   * may not orchestrate two services for itself
   * (`.claude/rules/daemon-module-structure.md`).
   *
   * The file goes FIRST, so a slug the library does not hold is its 404 and no
   * chat is destroyed for a team that was never there.
   */
  async deleteTeam(slug: string): Promise<void> {
    await this.store.delete(slug);
    await this.discard(slug);
    await this.analyses.deleteTeamAnalyses(slug);
  }
}
