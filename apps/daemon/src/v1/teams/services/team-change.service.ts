import { stat } from 'node:fs/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import {
  type AnalysedTeamRef,
  RECOMMENDATION_ID_PREFIX,
  type RecommendationApply,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { appliesOf, readCard } from '../../agents/utils/recommendations-card';
import { sizedUserInstructionFiles } from '../../agents/utils/user-instruction-files';
import type { AgentKind } from '../../runs/runs.types';
import type { Team } from '../teams.types';
import { firstLineOf } from '../utils/config-dir-redaction';
import { editTeam, TEAM_FILE_EDIT_COPY } from '../utils/edit-team';
import { backUpTeam, readTeamSource, sameBackupOf } from '../utils/team-backup';
import { diffTeams } from '../utils/team-diff';
import type { TeamEdit } from '../utils/team-edits';
import { parseTeamSnapshot } from '../utils/team-snapshot';
import { parseTeamYaml } from '../utils/team-yaml';
import { InstructionSizesService } from './instruction-sizes.service';
import { TeamChangeLogService } from './team-change-log.service';
import { TeamStoreService } from './team-store.service';

/**
 * Who may write this save, and against which version of the file. An analysis
 * writes only what the user selected in its latest Apply, against the hash it
 * read; a team's own builder chat writes whatever the user asks of it there,
 * to that team only, against the version its turn last knew.
 */
export type TeamChangeAuthority =
  | {
      kind: 'apply';
      /** The analysis chat asking; its latest Apply is what may be written. */
      analysisRunId: string;
      /** The recommendation ids this save carries out. */
      ids: string[];
      /** The hash `read_analyzed_thread` view=team answered. */
      baseHash: string;
    }
  | {
      kind: 'builder';
      /**
       * The version this turn's last save wrote (or a refusal reported), or
       * null before its first save — the agent reads the file with its own
       * tools and holds no hash.
       */
      savedHash: string | null;
      /**
       * When the turn began (epoch ms). Before the first save, a file written
       * after it was written by something other than the team editor, which does
       * not save while the chat works.
       */
      turnStartedAt: number;
      /**
       * A save of this turn was refused `TEAM_UNREADABLE`, so the agent
       * was told to repair the file itself: the version it repaired is the
       * one it now holds, whatever its hash or mtime.
       */
      acceptsAnyVersion: boolean;
    };

/** A save asked for through the `save_team_change` tool. */
export interface TeamChange {
  authority: TeamChangeAuthority;
  slug: string;
  /** What to change, applied in order to the file as it stands. */
  edits: TeamEdit[];
  dryRun: boolean;
}

type Answer = Record<string, unknown>;

/** Every (agent, profile) a member or one of its pool members runs under. */
function runnersOf(
  team: Team,
): { agent: AgentKind; configDir: string | null }[] {
  return team.members.flatMap((member) =>
    [member, ...(member.pool ?? [])].map((runner) => ({
      agent: runner.agent,
      configDir: runner.configDir ?? null,
    })),
  );
}

/**
 * The only path an analysis or a builder chat has to the team library:
 * every change is checked against its authority, against the file it was read
 * from, and against the team rules. For an analysis the file as it stood is
 * copied to a timed backup before `TeamStoreService.save` replaces it; a
 * builder chat backs up through {@link backUp}, when its agent calls
 * `backup_team`.
 *
 * In `v1/teams` because the store is, and called from `v1/mcp`, which imports
 * both modules; `v1/agents` may not import this one.
 */
@Injectable()
export class TeamChangeService {
  constructor(
    private readonly em: EntityManager,
    private readonly store: TeamStoreService,
    private readonly itemDao: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly instructionSizes: InstructionSizesService,
    private readonly changeLog: TeamChangeLogService,
  ) {}

  /**
   * The team as the library holds it now, the hash a save must quote, how
   * it differs from the copy a run started with, every agent's always-on
   * instruction block measured, and the user-instructions file of every agent
   * and pool member that copy ran, with its size.
   */
  async describe(
    slug: string,
    snapshot: string | null,
    /** What the run's turns were composed with beside the team; null when unknown. */
    instructions: AnalysedTeamRef['instructions'] = null,
  ): Promise<Answer> {
    const current = await this.readCurrent(slug);
    if (current === null) {
      return {
        error: 'TEAM_GONE',
        message: `the team '${slug}' is no longer in the library`,
      };
    }
    const started = parseTeamSnapshot(snapshot);
    return {
      slug,
      hash: current.hash,
      instructionSizes: this.instructionSizesOf(
        current.team,
        started.state === 'readable' ? started.team : null,
        instructions,
      ),
      userInstructions: await sizedUserInstructionFiles(
        this.adapters,
        runnersOf(started.state === 'readable' ? started.team : current.team),
      ),
      changedSinceThisRun:
        started.state === 'readable'
          ? diffTeams(started.team, current.team)
          : `unknown — the run's own copy is ${started.state}`,
      team: current.team,
    };
  }

  /**
   * Each member's always-on block as the library's copy composes it, with
   * the run's own custom instructions, memory index, card instructions and
   * reply language,
   * and — where the run's own copy composed a different length — that length.
   */
  private instructionSizesOf(
    current: Team,
    started: Team | null,
    instructions: AnalysedTeamRef['instructions'],
  ): Answer[] {
    const settings = {
      customInstructions: instructions?.customInstructions ?? undefined,
      replyLanguage: instructions?.replyLanguage ?? undefined,
      taskInstructions: instructions?.taskInstructions ?? undefined,
      projectInstructions: instructions?.projectInstructions ?? undefined,
      memoryIndex: instructions?.memoryIndex ?? undefined,
    };
    const inThisRun = new Map(
      (started === null
        ? []
        : this.instructionSizes.measure({ team: started, ...settings }).members
      ).map((member) => [member.memberId, member]),
    );
    return this.instructionSizes
      .measure({ team: current, ...settings })
      .members.map((member) => {
        const ran = inThisRun.get(member.memberId);
        return ran === undefined || ran.totalChars === member.totalChars
          ? member
          : {
              ...member,
              inThisRun: {
                totalChars: ran.totalChars,
                approxTokens: ran.approxTokens,
              },
            };
      });
  }

  async save(change: TeamChange): Promise<Answer> {
    const { authority } = change;
    if (authority.kind === 'apply') {
      const unapplied = await this.refuseUnapplied(authority);
      if (unapplied !== null) {
        return unapplied;
      }
    }
    const reread =
      authority.kind === 'apply'
        ? 'read view=team again'
        : 'read the file again';
    const file = await this.readFile(change.slug);
    if (file === null) {
      return refuse(
        'TEAM_GONE',
        `the team '${change.slug}' is no longer in the library — it is not re-created`,
      );
    }
    let team: Team;
    try {
      team = parseTeamYaml(file.source);
    } catch (error) {
      // The parser quotes the file's lines around the fault, a profile path
      // among them: the agent gets the first line, which names the fault.
      return refuse(
        'TEAM_UNREADABLE',
        `the file cannot be loaded (${firstLineOf(error instanceof Error ? error.message : String(error))}) — ${
          authority.kind === 'builder'
            ? 'fix only what this names, in the file, with your own file tools, then save the change again'
            : 'the file must be fixed before it can be changed'
        }`,
      );
    }
    const current: CurrentTeam = { ...file, team };
    if (changedSinceRead(authority, current)) {
      return {
        ...refuse(
          'HASH_DRIFT',
          `the team changed since you read it — ${reread} and re-apply on the new copy`,
        ),
        currentHash: current.hash,
      };
    }
    // A builder turn's answers from here on name the version it was checked
    // against, which its next save is then held to — after a repair too.
    const version =
      authority.kind === 'builder' ? { currentHash: current.hash } : {};
    // A builder chat may have read the team through `read_teams`, which
    // shows every `configDir` as a token: one it wrote back is put back as its
    // path.
    const edited = editTeam(
      current.team,
      change.edits,
      authority.kind === 'apply'
        ? 'view="team", as the decoded string rather than its JSON escapes'
        : TEAM_FILE_EDIT_COPY,
      authority.kind === 'builder',
    );
    if (!edited.ok) {
      return { ...refuse(edited.error, edited.message), ...version };
    }
    const next = edited.team;
    const diff = diffTeams(current.team, next);
    if (change.dryRun) {
      return { dryRun: true, saved: false, diff, ...version };
    }
    if (diff.identical) {
      return { saved: false, diff, message: 'nothing to change', ...version };
    }
    // A builder chat backs its file up when its agent decides
    // (`backup_team`, through `backUp`); an analysis's save always does.
    const backup =
      authority.kind === 'apply'
        ? await backUpTeam(
            this.store.locate(change.slug).directory,
            change.slug,
            current.source,
          )
        : null;
    // The store checks the hash again right before it writes, so a team editor
    // save landing after the check above is refused rather than overwritten.
    let saved: { hash: string };
    try {
      saved = await this.store.save(change.slug, next, current.hash);
    } catch (error) {
      if (
        error instanceof ConflictException &&
        error.errorCode === 'TEAM_CHANGED'
      ) {
        // Only the version: the write that beat this one may have left a file
        // that does not parse, and this answer must stay a refusal.
        const after = await readTeamSource(
          this.store.locate(change.slug).path,
        ).catch(() => null);
        return {
          ...refuse(
            'HASH_DRIFT',
            `the team changed while saving — ${reread} and re-apply on the new copy`,
          ),
          ...(after === null ? {} : { currentHash: after.hash }),
          ...(backup === null ? {} : { backup }),
        };
      }
      throw error;
    }
    if (authority.kind === 'apply') {
      await this.logApplied(change.slug, authority, current.team, next, backup);
    }
    return {
      saved: true,
      ...(backup === null ? {} : { backup }),
      // The version THIS save wrote — a later read could name a write that
      // landed after it, which the agent never saw.
      hash: saved.hash,
      diff,
    };
  }

  /**
   * Copy the team file as it stands to a timed backup — a builder chat's
   * `backup_team`, taken when its agent decides. Answers the backup's
   * path under the library, or `TEAM_GONE`.
   */
  async backUp(slug: string): Promise<Answer> {
    const current = await readTeamSource(this.store.locate(slug).path).catch(
      () => null,
    );
    if (current === null) {
      return refuse(
        'TEAM_GONE',
        `the team '${slug}' is no longer in the library`,
      );
    }
    const { directory } = this.store.locate(slug);
    const kept = await sameBackupOf(directory, slug, current.source);
    if (kept !== null) {
      return { backedUp: true, backup: kept, unchangedSinceThatBackup: true };
    }
    return {
      backedUp: true,
      backup: await backUpTeam(directory, slug, current.source),
    };
  }

  /**
   * Log an analysis's saved change under the Apply it carried out, titled by
   * the card's items. A card that can no longer be read leaves the entry
   * untitled: the ids still name the items.
   */
  private async logApplied(
    slug: string,
    authority: Extract<TeamChangeAuthority, { kind: 'apply' }>,
    before: Team,
    after: Team,
    backup: string | null,
  ): Promise<void> {
    const apply = await this.latestApply(authority.analysisRunId).catch(
      () => null,
    );
    const titles =
      apply === null
        ? []
        : await readCard(
            this.itemDao,
            authority.analysisRunId,
            apply.cardSeq,
            this.em.fork(),
          )
            .then((card) =>
              card.items
                .filter((item) => authority.ids.includes(item.id))
                .map((item) => `${item.id} ${item.title}`),
            )
            .catch(() => []);
    await this.changeLog.record({
      slug,
      source: 'analysis',
      before,
      after,
      summary: titles.join('; '),
      recommendationIds: authority.ids,
      chatRunId: authority.analysisRunId,
      cardSeq: apply?.cardSeq ?? null,
      backup,
    });
  }

  /** An analysis's save refused for what its latest Apply did not select, or null. */
  private async refuseUnapplied(
    authority: Extract<TeamChangeAuthority, { kind: 'apply' }>,
  ): Promise<Answer | null> {
    const apply = await this.latestApply(authority.analysisRunId);
    if (apply === null) {
      return refuse(
        'NOT_APPLIED',
        'nothing has been applied in this chat yet — team changes are saved only for items the user selected and applied',
      );
    }
    const otherItems = authority.ids.filter(
      (id) => !id.startsWith(RECOMMENDATION_ID_PREFIX.team),
    );
    if (otherItems.length > 0) {
      return refuse(
        'NOT_A_TEAM_ITEM',
        `${otherItems.join(', ')} ${otherItems.length === 1 ? 'is not a team item' : 'are not team items'} — only W- items change the team`,
      );
    }
    const unselected = authority.ids.filter((id) => !apply.ids.includes(id));
    if (authority.ids.length === 0 || unselected.length > 0) {
      return refuse(
        'NOT_SELECTED',
        authority.ids.length === 0
          ? 'name the recommendation ids this change carries out'
          : `${unselected.join(', ')} ${unselected.length === 1 ? 'was' : 'were'} not selected in the latest Apply (${apply.ids.join(', ')})`,
      );
    }
    return null;
  }

  private async readCurrent(slug: string): Promise<CurrentTeam | null> {
    const file = await this.readFile(slug);
    return file === null ? null : { ...file, team: parseTeamYaml(file.source) };
  }

  /**
   * The file's text, hash and mtime, or null when it is gone. The mtime is
   * taken AFTER the text: a write landing between the two makes the mtime
   * newer than the text, which refuses the save, where the other order would
   * apply the edits to a version the agent never read.
   */
  private async readFile(
    slug: string,
  ): Promise<Omit<CurrentTeam, 'team'> | null> {
    const path = this.store.locate(slug).path;
    // Any unreadable file reads as gone here, as it always has: a save
    // refuses it either way.
    const current = await readTeamSource(path).catch(() => null);
    if (current === null) {
      return null;
    }
    const modifiedAt = await stat(path)
      .then((stats) => stats.mtimeMs)
      .catch(() => null);
    return { ...current, modifiedAt };
  }

  /** The selection of the newest Apply sent in this chat, or null. */
  private async latestApply(
    runId: string,
  ): Promise<RecommendationApply | null> {
    return (
      (await appliesOf(this.itemDao, runId, this.em.fork())).at(-1) ?? null
    );
  }
}

interface CurrentTeam {
  source: string;
  hash: string;
  /** The file's mtime, or null when it could not be read. */
  modifiedAt: number | null;
  team: Team;
}

/**
 * Whether the file is not the version the save was asked against. A builder
 * turn before its first save holds no hash: anything written after the turn
 * began counts, and an unreadable mtime counts too, refusing rather than
 * overwriting a change it cannot rule out.
 */
function changedSinceRead(
  authority: TeamChangeAuthority,
  current: CurrentTeam,
): boolean {
  if (authority.kind === 'apply') {
    return current.hash !== authority.baseHash;
  }
  if (authority.acceptsAnyVersion) {
    return false;
  }
  if (authority.savedHash !== null) {
    return current.hash !== authority.savedHash;
  }
  // An mtime keeps a fraction of a millisecond and the turn's start does not,
  // so the two are compared in whole milliseconds: a write in the turn's first
  // millisecond is the team editor's last save before the send, not a later one.
  return (
    current.modifiedAt === null ||
    Math.floor(current.modifiedAt) > authority.turnStartedAt
  );
}

function refuse(error: string, message: string): Answer {
  return { saved: false, error, message };
}
