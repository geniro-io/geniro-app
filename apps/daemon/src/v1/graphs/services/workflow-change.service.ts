import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import {
  RECOMMENDATION_ID_PREFIX,
  type RecommendationApply,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { appliesOf } from '../../agents/utils/recommendations-card';
import { userInstructionFiles } from '../../agents/utils/user-instruction-files';
import type { AgentKind } from '../../runs/runs.types';
import type { Workflow } from '../graphs.types';
import { backUpWorkflow, readWorkflowSource } from '../utils/workflow-backup';
import { checkWorkflow } from '../utils/workflow-check';
import { diffWorkflows } from '../utils/workflow-diff';
import { parseWorkflowSnapshot } from '../utils/workflow-snapshot';
import { parseWorkflowYaml } from '../utils/workflow-yaml';
import { WorkflowStoreService } from './workflow-store.service';

/** A save an analysis asks for — see the `save_workflow_change` tool. */
export interface WorkflowChange {
  /** The analysis chat asking; its latest Apply is what may be written. */
  analysisRunId: string;
  slug: string;
  workflow: unknown;
  /** The hash the agent read the workflow at (`read_analyzed_thread` view=workflow). */
  baseHash: string;
  /** The recommendation ids this save carries out. */
  ids: string[];
  dryRun: boolean;
}

type Answer = Record<string, unknown>;

/** Every (agent, profile) an agent node or one of its pool members runs under. */
function runnersOf(
  workflow: Workflow,
): { agent: AgentKind; configDir: string | null }[] {
  return workflow.nodes.flatMap((node) =>
    node.kind === 'agent'
      ? [node, ...(node.pool ?? [])].map((member) => ({
          agent: member.agent,
          configDir: member.configDir ?? null,
        }))
      : [],
  );
}

/**
 * The only path an analysis has to the workflow library: every change is
 * checked against what the user selected, against the file it was read from,
 * and against the graph rules — and the file as it stood is copied to a timed
 * backup before `WorkflowStoreService.save` replaces it.
 *
 * In `v1/graphs` because the store is, and called from `v1/mcp`, which imports
 * both modules; `v1/agents` may not import this one.
 */
@Injectable()
export class WorkflowChangeService {
  constructor(
    private readonly em: EntityManager,
    private readonly store: WorkflowStoreService,
    private readonly itemDao: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /**
   * The workflow as the library holds it now, the hash a save must quote, how
   * it differs from the copy a run started with, and the user-instructions
   * file of every agent and pool member that copy ran.
   */
  async describe(slug: string, snapshot: string | null): Promise<Answer> {
    const current = await this.readCurrent(slug);
    if (current === null) {
      return {
        error: 'WORKFLOW_GONE',
        message: `the workflow '${slug}' is no longer in the library`,
      };
    }
    const started = parseWorkflowSnapshot(snapshot);
    return {
      slug,
      hash: current.hash,
      workflow: current.workflow,
      changedSinceThisRun:
        started.state === 'readable'
          ? diffWorkflows(started.workflow, current.workflow)
          : `unknown — the run's own copy is ${started.state}`,
      userInstructions: userInstructionFiles(
        this.adapters,
        runnersOf(
          started.state === 'readable' ? started.workflow : current.workflow,
        ),
      ),
    };
  }

  async save(change: WorkflowChange): Promise<Answer> {
    const apply = await this.latestApply(change.analysisRunId);
    if (apply === null) {
      return refuse(
        'NOT_APPLIED',
        'nothing has been applied in this chat yet — workflow changes are saved only for items the user selected and applied',
      );
    }
    const otherItems = change.ids.filter(
      (id) => !id.startsWith(RECOMMENDATION_ID_PREFIX.workflow),
    );
    if (otherItems.length > 0) {
      return refuse(
        'NOT_A_WORKFLOW_ITEM',
        `${otherItems.join(', ')} ${otherItems.length === 1 ? 'is not a workflow item' : 'are not workflow items'} — only W- items change the workflow`,
      );
    }
    const unselected = change.ids.filter((id) => !apply.ids.includes(id));
    if (change.ids.length === 0 || unselected.length > 0) {
      return refuse(
        'NOT_SELECTED',
        change.ids.length === 0
          ? 'name the recommendation ids this change carries out'
          : `${unselected.join(', ')} ${unselected.length === 1 ? 'was' : 'were'} not selected in the latest Apply (${apply.ids.join(', ')})`,
      );
    }
    const current = await this.readCurrent(change.slug);
    if (current === null) {
      return refuse(
        'WORKFLOW_GONE',
        `the workflow '${change.slug}' is no longer in the library — it is not re-created`,
      );
    }
    if (current.hash !== change.baseHash) {
      return {
        ...refuse(
          'HASH_DRIFT',
          'the workflow changed since you read it — read view=workflow again and re-apply on the new copy',
        ),
        currentHash: current.hash,
      };
    }
    const checked = checkWorkflow(change.workflow);
    if (!checked.ok) {
      return refuse('INVALID_WORKFLOW', checked.message);
    }
    const diff = diffWorkflows(current.workflow, checked.workflow);
    if (change.dryRun) {
      return { dryRun: true, saved: false, diff };
    }
    if (diff.identical) {
      return { saved: false, diff, message: 'nothing to change' };
    }
    const backup = await backUpWorkflow(
      this.store.locate(change.slug).directory,
      change.slug,
      current.source,
    );
    // The store checks the hash again right before it writes, so a builder
    // save landing after the check above is refused rather than overwritten.
    let saved: { hash: string };
    try {
      saved = await this.store.save(
        change.slug,
        checked.workflow,
        current.hash,
      );
    } catch (error) {
      if (
        error instanceof ConflictException &&
        error.errorCode === 'WORKFLOW_CHANGED'
      ) {
        return {
          ...refuse(
            'HASH_DRIFT',
            'the workflow changed while saving — read view=workflow again and re-apply on the new copy',
          ),
          backup,
        };
      }
      throw error;
    }
    return {
      saved: true,
      backup,
      // The version THIS save wrote — a later read could name a write that
      // landed after it, which the agent never saw.
      hash: saved.hash,
      diff,
    };
  }

  private async readCurrent(
    slug: string,
  ): Promise<{ source: string; hash: string; workflow: Workflow } | null> {
    // Any unreadable file reads as gone here, as it always has: an analysis's
    // save refuses it either way.
    const current = await readWorkflowSource(
      this.store.locate(slug).path,
    ).catch(() => null);
    return current === null
      ? null
      : { ...current, workflow: parseWorkflowYaml(current.source) };
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

function refuse(error: string, message: string): Answer {
  return { saved: false, error, message };
}
