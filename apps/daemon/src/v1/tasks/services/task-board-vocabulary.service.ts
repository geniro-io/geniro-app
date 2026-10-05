import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentVersionService } from '../../agents/services/agent-version.service';
import { EffortsService } from '../../agents/services/efforts.service';
import { ModelsService } from '../../agents/services/models.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { childProcessHandle } from '../../agents/utils/child-handle';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { AgentKind } from '../../runs/runs.types';
import { LabelInstructionDao } from '../dao/label-instruction.dao';
import { TaskDao } from '../dao/task.dao';
import type { BoardVocabulary } from '../tasks.types';
import { parseLabels } from '../utils/task-labels';

/**
 * The `board_vocabulary` answer: the card values that belong to this machine
 * — labels in use, workflows, CLIs, models, efforts, config directories — so an
 * agent filing a card spells them exactly instead of guessing.
 *
 * Every listing is read from where the app itself reads it (the board's rows,
 * the workflow library, each adapter's own config, the composer's cached model
 * and effort listings), so the answer cannot describe a vocabulary the board
 * does not have.
 */
@Injectable()
export class TaskBoardVocabularyService {
  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly labelInstructionDao: LabelInstructionDao,
    private readonly workflows: WorkflowStoreService,
    private readonly adapters: AgentAdapterRegistry,
    private readonly versions: AgentVersionService,
    private readonly processes: ProcessRegistry,
    private readonly models: ModelsService,
    private readonly efforts: EffortsService,
  ) {}

  async read(
    agentKind: AgentKind | null,
    model: string | null,
  ): Promise<BoardVocabulary> {
    const em = this.em.fork();
    const projects = await this.projectDao.listAll(em);
    const nameOf = new Map(
      projects.map((project) => [project.id, project.taskKey ?? project.name]),
    );
    const tasks = await this.taskDao.listBoardFacts(em);

    const labels = new Map<
      string,
      { cards: number; projects: Set<string>; instructionsFor: Set<string> }
    >();
    const entry = (label: string) => {
      let found = labels.get(label);
      if (found === undefined) {
        found = { cards: 0, projects: new Set(), instructionsFor: new Set() };
        labels.set(label, found);
      }
      return found;
    };
    for (const task of tasks) {
      for (const label of parseLabels(task.labels)) {
        const found = entry(label);
        found.cards += 1;
        found.projects.add(nameOf.get(task.projectId) ?? task.projectId);
      }
    }
    for (const row of await this.labelInstructionDao.listForScope(null, em)) {
      entry(row.label).instructionsFor.add(
        row.projectId === null
          ? 'every project'
          : (nameOf.get(row.projectId) ?? row.projectId),
      );
    }

    const configDirs = new Set<string>();
    for (const row of [...projects, ...tasks]) {
      if (row.configDir !== null) {
        configDirs.add(row.configDir);
      }
    }

    // Independent and each possibly slow (a `--version` spawn, a CLI
    // handshake for the models), so they are awaited together.
    const [workflows, agents, models] = await Promise.all([
      this.workflows.list(),
      Promise.all(
        [...this.adapters.all()].map(async ([kind, adapter]) => {
          const config = adapter.getConfig();
          return {
            agentKind: kind,
            name: config.identity.displayName,
            version: await this.versions.resolve(kind, {
              onSpawn: (child, spawnInfo) =>
                this.processes.register(
                  `board:version:${randomUUID()}`,
                  childProcessHandle(child, spawnInfo),
                ),
            }),
            approvalModes: [...config.approval.modes],
          };
        }),
      ),
      agentKind === null ? null : this.modelsOf(agentKind, model),
    ]);

    return {
      labels: [...labels.entries()]
        .map(([label, found]) => ({
          label,
          cards: found.cards,
          projects: [...found.projects].sort(),
          instructionsFor: [...found.instructionsFor].sort(),
        }))
        .sort((a, b) => b.cards - a.cards || a.label.localeCompare(b.label)),
      workflows: workflows.map((workflow) => ({
        slug: workflow.slug,
        name: workflow.name,
        description: workflow.description,
      })),
      agents,
      configDirs: [...configDirs].sort(),
      ...(models === null ? {} : { models }),
    };
  }

  private async modelsOf(
    agentKind: AgentKind,
    model: string | null,
  ): Promise<NonNullable<BoardVocabulary['models']>> {
    const [models, efforts] = await Promise.all([
      this.models.list(agentKind),
      this.efforts.list(agentKind, model),
    ]);
    return {
      agentKind,
      models: models.map(({ id, label }) => ({ id, label })),
      efforts: efforts.efforts.map(({ id, label }) => ({ id, label })),
      effortsFor: model,
      effortsUnavailableReason: efforts.unavailableReason,
    };
  }
}
