import { Injectable, type OnModuleInit } from '@nestjs/common';

import { ProjectsService } from '../../projects/services/projects.service';
import { KnowledgeService } from './knowledge.service';

/**
 * Registers the knowledge store with a project's removal, which runs inside a
 * transaction of `ProjectsService`: that module may not import this one.
 */
@Injectable()
export class KnowledgeProjectRemovalService implements OnModuleInit {
  constructor(
    private readonly projects: ProjectsService,
    private readonly knowledge: KnowledgeService,
  ) {}

  onModuleInit(): void {
    this.projects.useRemovalParticipant((projectId, fate, tx) =>
      this.knowledge.settleRemovedProject(projectId, fate, tx),
    );
  }
}
