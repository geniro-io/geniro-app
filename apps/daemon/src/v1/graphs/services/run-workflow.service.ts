import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { assertWorkflowRun } from '../../agents/utils/run-kind';
import type { Run } from '../../runs/entity/run.entity';
import type { RunWorkflowSnapshotWire, Workflow } from '../graphs.types';
import {
  readWorkflowSnapshot,
  workflowSnapshotOf,
} from '../utils/workflow-snapshot';
import { WorkflowStoreService } from './workflow-store.service';

/**
 * The ONE answer to "which graph does this existing run run" — its snapshot,
 * never the library's current copy.
 *
 * Asked for as "old workflows chats should not be changed if i change current
 * workflow. They should use snapshots". Every reader of an existing run's graph
 * goes through here — a follow-up pass, the agents panel, the terminal handoff,
 * a task's settle — because each one that read the library on its own was a
 * place an edit reached a run it must not.
 *
 * A run made before runs kept a copy is FROZEN on its first read: the library
 * copy as it is at that moment is written onto the run and used from then on.
 * Chosen over refusing such a run (a live run could not be continued) and over
 * reading the library for it forever (the defect, kept for every run that
 * already exists).
 */
@Injectable()
export class RunWorkflowService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly store: WorkflowStoreService,
  ) {}

  /**
   * The graph a workflow run runs. The run object passed in is updated too
   * when this freezes it, so a caller holding it sees the same copy.
   */
  async workflowOf(
    run: Pick<Run, 'id' | 'workflowSnapshot'> & { workflowId: string },
    em?: EntityManager,
  ): Promise<Workflow> {
    const kept = readWorkflowSnapshot(run.workflowSnapshot);
    if (kept !== null) {
      return kept;
    }
    const { workflow } = await this.store.get(run.workflowId);
    const snapshot = workflowSnapshotOf(workflow);
    // Freezing a copy on first READ is not activity in the run — see
    // `RunDao.updateWithoutActivity`.
    await this.runDao.updateWithoutActivity(
      run.id,
      { workflowSnapshot: snapshot },
      em,
    );
    run.workflowSnapshot = snapshot;
    return workflow;
  }

  /** The wire answer for `GET /v1/workflows/runs/:runId/workflow`. */
  async snapshotOfRun(runId: string): Promise<RunWorkflowSnapshotWire> {
    const em = this.em.fork();
    const run = assertWorkflowRun(await this.runDao.getById(runId, em), runId);
    return { workflow: await this.workflowOf(run, em) };
  }
}
