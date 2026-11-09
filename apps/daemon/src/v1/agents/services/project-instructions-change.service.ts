import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import type {
  ProjectInstructionBlock,
  ProjectWire,
} from '../../projects/projects.types';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { ProjectsService } from '../../projects/services/projects.service';
import {
  blocksDocument,
  checkedProjectChange,
  type ProjectBlockInput,
} from '../../projects/utils/project-instruction-blocks';
import {
  type AnalysisTurn,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
  type RecommendationApply,
  type RecommendationsPayload,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { analysedProjectIdsOf } from '../utils/analysed-runs';
import { hostProjectInstructionsResultText } from '../utils/host-project-instructions';
import {
  appliesOf,
  readCard,
  unappliedRefusal,
} from '../utils/recommendations-card';

/** What an analysis asks `save_project_instructions` to write. */
export interface ProjectInstructionsChange {
  turn: AnalysisTurn;
  projectId: string;
  /** Every block as it should read after the change, in order (an id alone keeps that block); none clears them. */
  blocks: ProjectBlockInput[];
  /** The `instructionsRevision` view=project returned. */
  baseRevision: number;
  /** The `P-` ids the change carries out. */
  ids: readonly string[];
}

/** What a chat asks `save_project_instructions` to write, carrying out no applied item. */
export interface ProjectChatInstructionsChange {
  chatRunId: string;
  projectId: string;
  /** Every block as it should read after the change, in order (an id alone keeps that block); none clears them. */
  blocks: ProjectBlockInput[];
  /** The revision the chat read the blocks at. */
  baseRevision: number;
}

type Answer = Record<string, unknown>;

function refuse(error: string, message: string): Answer {
  return { error, message };
}

/** Puts a checked change on the user's card and resolves with their answer. */
export type ProjectInstructionsCard = (
  change: HostProjectInstructions,
) => Promise<HostProjectInstructionsOutcome>;

/**
 * An analysis's one write to a project: its instructions — never its
 * description — for `P-` items the user selected in the newest Apply, each
 * filed about that project, quoting the revision it read; and a project
 * chat's write to its own project's instructions ({@link saveForChat}). A change that passes
 * those checks is put on a card with the old and new text, and only the
 * card's Apply writes it (`write`), through `ProjectsService.update`, which
 * logs it as the analysis's and announces `projects_changed`.
 */
@Injectable()
export class ProjectInstructionsChangeService {
  private readonly logger = new Logger(ProjectInstructionsChangeService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly projectScope: ProjectScopeService,
    private readonly projects: ProjectsService,
  ) {}

  async save(
    change: ProjectInstructionsChange,
    card: ProjectInstructionsCard,
  ): Promise<Answer> {
    const em = this.em.fork();
    const apply = (
      await appliesOf(this.itemDao, change.turn.analysisRunId, em)
    ).at(-1);
    if (apply === undefined) {
      return refuse(
        'NOT_APPLIED',
        'nothing has been applied in this chat yet — project instructions are saved only for items the user selected and applied',
      );
    }
    const refusal =
      unappliedRefusal('project', change.ids, apply) ??
      (await this.refuseOtherProject(change, apply, em));
    if (refusal !== null) {
      return refusal;
    }
    let project: ProjectWire;
    try {
      project = await this.projects.get(change.projectId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        return refuse('PROJECT_GONE', 'the project has been deleted');
      }
      throw error;
    }
    if (project.instructionsRevision !== change.baseRevision) {
      return refuse('REVISION_DRIFT', driftMessage(change.baseRevision));
    }
    const checked = checkedChange(change.blocks, project);
    if (!checked.ok) {
      return checked.refusal;
    }
    const blocks = checked.blocks;
    const previous = blocksDocument(project.instructionBlocks);
    const next = blocksDocument(blocks);
    const receipt = {
      projectId: project.id,
      project: project.name,
      carriedOut: change.ids,
    };
    if (sameBlocks(blocks, project.instructionBlocks)) {
      return {
        saved: true,
        ...receipt,
        changed: false,
        instructionsRevision: project.instructionsRevision,
      };
    }
    const outcome = await card({
      projectId: project.id,
      project: project.name,
      previous,
      next,
      blocks,
      baseRevision: change.baseRevision,
      ids: [...change.ids],
      cardSeq: apply.cardSeq,
    });
    switch (outcome.status) {
      case 'saved':
        return {
          saved: true,
          ...receipt,
          changed: true,
          instructionsRevision: outcome.instructionsRevision,
        };
      case 'declined':
        return {
          saved: false,
          declined: true,
          message: hostProjectInstructionsResultText(outcome),
        };
      case 'posted':
        return {
          posted: true,
          message: hostProjectInstructionsResultText(outcome),
        };
      case 'stale':
        return refuse('STALE', hostProjectInstructionsResultText(outcome));
      case 'unavailable':
        return refuse(
          'UNAVAILABLE',
          hostProjectInstructionsResultText(outcome),
        );
    }
  }

  /**
   * A chat's change to any project's blocks: checked against the revision it
   * read them at, then put on the same card. A drift is answered with the blocks
   * as they stand, since a project chat's brief is not written again until the
   * next turn.
   */
  async saveForChat(
    change: ProjectChatInstructionsChange,
    card: ProjectInstructionsCard,
  ): Promise<Answer> {
    let project: ProjectWire;
    try {
      project = await this.projects.get(change.projectId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        return refuse('PROJECT_GONE', 'the project has been deleted');
      }
      throw error;
    }
    if (project.instructionsRevision !== change.baseRevision) {
      return {
        ...refuse(
          'REVISION_DRIFT',
          `the project's instructions changed since revision ${change.baseRevision} — make your edits again on the blocks below and pass instructionsRevision as baseRevision`,
        ),
        instructionsRevision: project.instructionsRevision,
        blocks: project.instructionBlocks,
      };
    }
    const checked = checkedChange(change.blocks, project);
    if (!checked.ok) {
      return checked.refusal;
    }
    const blocks = checked.blocks;
    const receipt = { projectId: project.id, project: project.name };
    if (sameBlocks(blocks, project.instructionBlocks)) {
      return {
        saved: true,
        ...receipt,
        changed: false,
        instructionsRevision: project.instructionsRevision,
      };
    }
    const outcome = await card({
      projectId: project.id,
      project: project.name,
      previous: blocksDocument(project.instructionBlocks),
      next: blocksDocument(blocks),
      blocks,
      baseRevision: change.baseRevision,
      ids: [],
      cardSeq: null,
    });
    switch (outcome.status) {
      case 'saved':
        return {
          saved: true,
          ...receipt,
          changed: true,
          instructionsRevision: outcome.instructionsRevision,
        };
      case 'declined':
        return {
          saved: false,
          declined: true,
          message: hostProjectInstructionsResultText(outcome, true),
        };
      case 'posted':
        return {
          posted: true,
          message: hostProjectInstructionsResultText(outcome, true),
        };
      case 'stale':
        return refuse(
          'STALE',
          hostProjectInstructionsResultText(outcome, true),
        );
      case 'unavailable':
        return refuse(
          'UNAVAILABLE',
          hostProjectInstructionsResultText(outcome, true),
        );
    }
  }

  /** The card's Apply: the change written over the revision it was read at, or why it could not be. */
  async write(
    chatRunId: string,
    change: HostProjectInstructions,
  ): Promise<HostProjectInstructionsOutcome> {
    try {
      const saved = await this.projects.update(
        change.projectId,
        {
          instructionBlocks: change.blocks,
          expectedInstructionsRevision: change.baseRevision,
        },
        {
          source: change.cardSeq === null ? 'chat' : 'analysis',
          recommendationIds: change.ids,
          chatRunId,
          cardSeq: change.cardSeq,
        },
      );
      return {
        status: 'saved',
        instructionsRevision: saved.instructionsRevision,
      };
    } catch (error) {
      if (error instanceof ConflictException) {
        return {
          status: 'stale',
          reason: 'the instructions were changed after the card was raised',
        };
      }
      if (error instanceof NotFoundException) {
        return { status: 'stale', reason: 'the project has been deleted' };
      }
      if (error instanceof BadRequestException) {
        return { status: 'stale', reason: error.message };
      }
      this.logger.error(
        `chat ${chatRunId} could not save project ${change.projectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'stale', reason: 'the instructions could not be saved' };
    }
  }

  /** A project the analysed runs do not belong to, or an item filed about another one. */
  private async refuseOtherProject(
    change: ProjectInstructionsChange,
    apply: RecommendationApply,
    em: EntityManager,
  ): Promise<Answer | null> {
    const analysed = await analysedProjectIdsOf(
      change.turn,
      { runDao: this.runDao, projectScope: this.projectScope },
      em,
    );
    if (!analysed.has(change.projectId)) {
      return refuse(
        'NOT_ANALYSED_PROJECT',
        analysed.size === 0
          ? 'the analysed runs belong to no project'
          : `${change.projectId} is not the project of an analysed run (${[...analysed].join(', ')}) — view=project names it`,
      );
    }
    let card: RecommendationsPayload;
    try {
      card = await readCard(
        this.itemDao,
        change.turn.analysisRunId,
        apply.cardSeq,
        em,
      );
    } catch {
      return refuse(
        'CARD_GONE',
        'the recommendations card the Apply named cannot be read',
      );
    }
    const elsewhere = change.ids.filter(
      (id) =>
        card.items.find((item) => item.id === id)?.location !==
        change.projectId,
    );
    return elsewhere.length > 0
      ? refuse(
          'OTHER_PROJECT',
          `${elsewhere.join(', ')} ${elsewhere.length === 1 ? 'was' : 'were'} not filed about ${change.projectId} — save each project's items with its own projectId`,
        )
      : null;
  }
}

/** The change's blocks filled in and checked, or the refusal the agent is answered with. */
function checkedChange(
  inputs: readonly ProjectBlockInput[],
  project: Pick<ProjectWire, 'instructionBlocks'>,
):
  | { ok: true; blocks: ProjectInstructionBlock[] }
  | { ok: false; refusal: Answer } {
  const checked = checkedProjectChange(inputs, project.instructionBlocks);
  return checked.ok
    ? checked
    : {
        ok: false,
        refusal: {
          ...refuse(checked.error, checked.message),
          ...checked.figures,
        },
      };
}

function driftMessage(baseRevision: number): string {
  return `the project's instructions changed since revision ${baseRevision} — read view=project again and re-apply`;
}

/** Whether two block lists say the same, whitespace around a title or text aside. */
function sameBlocks(
  a: readonly ProjectInstructionBlock[],
  b: readonly ProjectInstructionBlock[],
): boolean {
  const trimmed = (blocks: readonly ProjectInstructionBlock[]) =>
    JSON.stringify(
      blocks.map((block) => [block.id, block.title.trim(), block.text.trim()]),
    );
  return trimmed(a) === trimmed(b);
}
