import { stat } from 'node:fs/promises';

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
import { firstLineOf, restoreConfigDirs } from '../utils/config-dir-redaction';
import {
  backUpWorkflow,
  readWorkflowSource,
  sameBackupOf,
} from '../utils/workflow-backup';
import { checkWorkflow } from '../utils/workflow-check';
import { diffWorkflows } from '../utils/workflow-diff';
import { applyWorkflowEdits, type WorkflowEdit } from '../utils/workflow-edits';
import { parseWorkflowSnapshot } from '../utils/workflow-snapshot';
import { parseWorkflowYaml } from '../utils/workflow-yaml';
import { WorkflowStoreService } from './workflow-store.service';

/**
 * Who may write this save, and against which version of the file. An analysis
 * writes only what the user selected in its latest Apply, against the hash it
 * read; a workflow's own builder chat writes whatever the user asks of it there,
 * to that workflow only, against the version its turn last knew.
 */
export type WorkflowChangeAuthority =
  | {
      kind: 'apply';
      /** The analysis chat asking; its latest Apply is what may be written. */
      analysisRunId: string;
      /** The recommendation ids this save carries out. */
      ids: string[];
      /** The hash `read_analyzed_thread` view=workflow answered. */
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
       * after it was written by something other than the canvas, which does
       * not save while the chat works.
       */
      turnStartedAt: number;
      /**
       * A save of this turn was refused `WORKFLOW_UNREADABLE`, so the agent
       * was told to repair the file itself: the version it repaired is the
       * one it now holds, whatever its hash or mtime.
       */
      acceptsAnyVersion: boolean;
    };

/** A save asked for through the `save_workflow_change` tool. */
export interface WorkflowChange {
  authority: WorkflowChangeAuthority;
  slug: string;
  /** What to change, applied in order to the file as it stands. */
  edits: WorkflowEdit[];
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
 * The only path an analysis or a builder chat has to the workflow library:
 * every change is checked against its authority, against the file it was read
 * from, and against the graph rules. For an analysis the file as it stood is
 * copied to a timed backup before `WorkflowStoreService.save` replaces it; a
 * builder chat backs up through {@link backUp}, when its agent calls
 * `backup_workflow`.
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
    const { authority } = change;
    if (authority.kind === 'apply') {
      const unapplied = await this.refuseUnapplied(authority);
      if (unapplied !== null) {
        return unapplied;
      }
    }
    const reread =
      authority.kind === 'apply'
        ? 'read view=workflow again'
        : 'read the file again';
    const file = await this.readFile(change.slug);
    if (file === null) {
      return refuse(
        'WORKFLOW_GONE',
        `the workflow '${change.slug}' is no longer in the library — it is not re-created`,
      );
    }
    let workflow: Workflow;
    try {
      workflow = parseWorkflowYaml(file.source);
    } catch (error) {
      // The parser quotes the file's lines around the fault, a profile path
      // among them: the agent gets the first line, which names the fault.
      return refuse(
        'WORKFLOW_UNREADABLE',
        `the file cannot be loaded (${firstLineOf(error instanceof Error ? error.message : String(error))}) — ${
          authority.kind === 'builder'
            ? 'fix only what this names, in the file, with your own file tools, then save the change again'
            : 'the file must be fixed before it can be changed'
        }`,
      );
    }
    const current: CurrentWorkflow = { ...file, workflow };
    if (changedSinceRead(authority, current)) {
      return {
        ...refuse(
          'HASH_DRIFT',
          `the workflow changed since you read it — ${reread} and re-apply on the new copy`,
        ),
        currentHash: current.hash,
      };
    }
    // A builder turn's answers from here on name the version it was checked
    // against, which its next save is then held to — after a repair too.
    const version =
      authority.kind === 'builder' ? { currentHash: current.hash } : {};
    const edited = applyWorkflowEdits(
      current.workflow,
      change.edits,
      authority.kind === 'apply'
        ? 'view="workflow", as the decoded string rather than its JSON escapes'
        : 'the workflow file, as the string value itself rather than its YAML quoting or line folding',
    );
    if (!edited.ok) {
      return { ...refuse('INVALID_EDIT', edited.message), ...version };
    }
    const checked = checkWorkflow(edited.workflow);
    if (!checked.ok) {
      return { ...refuse('INVALID_WORKFLOW', checked.message), ...version };
    }
    // A builder chat may have read the workflow through `read_workflows`, which
    // shows every `configDir` as a token: one it wrote back is put back as its
    // path.
    const restored =
      authority.kind === 'builder'
        ? restoreConfigDirs(checked.workflow, current.workflow)
        : checked;
    if (!restored.ok) {
      return {
        ...refuse('CONFIG_DIR_UNKNOWN', restored.message),
        ...version,
      };
    }
    const next = restored.workflow;
    const diff = diffWorkflows(current.workflow, next);
    if (change.dryRun) {
      return { dryRun: true, saved: false, diff, ...version };
    }
    if (diff.identical) {
      return { saved: false, diff, message: 'nothing to change', ...version };
    }
    // A builder chat backs its file up when its agent decides
    // (`backup_workflow`, through `backUp`); an analysis's save always does.
    const backup =
      authority.kind === 'apply'
        ? await backUpWorkflow(
            this.store.locate(change.slug).directory,
            change.slug,
            current.source,
          )
        : null;
    // The store checks the hash again right before it writes, so a canvas
    // save landing after the check above is refused rather than overwritten.
    let saved: { hash: string };
    try {
      saved = await this.store.save(change.slug, next, current.hash);
    } catch (error) {
      if (
        error instanceof ConflictException &&
        error.errorCode === 'WORKFLOW_CHANGED'
      ) {
        // Only the version: the write that beat this one may have left a file
        // that does not parse, and this answer must stay a refusal.
        const after = await readWorkflowSource(
          this.store.locate(change.slug).path,
        ).catch(() => null);
        return {
          ...refuse(
            'HASH_DRIFT',
            `the workflow changed while saving — ${reread} and re-apply on the new copy`,
          ),
          ...(after === null ? {} : { currentHash: after.hash }),
          ...(backup === null ? {} : { backup }),
        };
      }
      throw error;
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
   * Copy the workflow file as it stands to a timed backup — a builder chat's
   * `backup_workflow`, taken when its agent decides. Answers the backup's
   * path under the library, or `WORKFLOW_GONE`.
   */
  async backUp(slug: string): Promise<Answer> {
    const current = await readWorkflowSource(
      this.store.locate(slug).path,
    ).catch(() => null);
    if (current === null) {
      return refuse(
        'WORKFLOW_GONE',
        `the workflow '${slug}' is no longer in the library`,
      );
    }
    const { directory } = this.store.locate(slug);
    const kept = await sameBackupOf(directory, slug, current.source);
    if (kept !== null) {
      return { backedUp: true, backup: kept, unchangedSinceThatBackup: true };
    }
    return {
      backedUp: true,
      backup: await backUpWorkflow(directory, slug, current.source),
    };
  }

  /** An analysis's save refused for what its latest Apply did not select, or null. */
  private async refuseUnapplied(
    authority: Extract<WorkflowChangeAuthority, { kind: 'apply' }>,
  ): Promise<Answer | null> {
    const apply = await this.latestApply(authority.analysisRunId);
    if (apply === null) {
      return refuse(
        'NOT_APPLIED',
        'nothing has been applied in this chat yet — workflow changes are saved only for items the user selected and applied',
      );
    }
    const otherItems = authority.ids.filter(
      (id) => !id.startsWith(RECOMMENDATION_ID_PREFIX.workflow),
    );
    if (otherItems.length > 0) {
      return refuse(
        'NOT_A_WORKFLOW_ITEM',
        `${otherItems.join(', ')} ${otherItems.length === 1 ? 'is not a workflow item' : 'are not workflow items'} — only W- items change the workflow`,
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

  private async readCurrent(slug: string): Promise<CurrentWorkflow | null> {
    const file = await this.readFile(slug);
    return file === null
      ? null
      : { ...file, workflow: parseWorkflowYaml(file.source) };
  }

  /**
   * The file's text, hash and mtime, or null when it is gone. The mtime is
   * taken AFTER the text: a write landing between the two makes the mtime
   * newer than the text, which refuses the save, where the other order would
   * apply the edits to a version the agent never read.
   */
  private async readFile(
    slug: string,
  ): Promise<Omit<CurrentWorkflow, 'workflow'> | null> {
    const path = this.store.locate(slug).path;
    // Any unreadable file reads as gone here, as it always has: a save
    // refuses it either way.
    const current = await readWorkflowSource(path).catch(() => null);
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

interface CurrentWorkflow {
  source: string;
  hash: string;
  /** The file's mtime, or null when it could not be read. */
  modifiedAt: number | null;
  workflow: Workflow;
}

/**
 * Whether the file is not the version the save was asked against. A builder
 * turn before its first save holds no hash: anything written after the turn
 * began counts, and an unreadable mtime counts too, refusing rather than
 * overwriting a change it cannot rule out.
 */
function changedSinceRead(
  authority: WorkflowChangeAuthority,
  current: CurrentWorkflow,
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
  // millisecond is the canvas's last save before the send, not a later one.
  return (
    current.modifiedAt === null ||
    Math.floor(current.modifiedAt) > authority.turnStartedAt
  );
}

function refuse(error: string, message: string): Answer {
  return { saved: false, error, message };
}
