import { Injectable } from '@nestjs/common';

import { MemoryService } from '../../memory/services/memory.service';
import { ProjectsService } from '../../projects/services/projects.service';
import { projectInstructionsText } from '../../projects/utils/project-instructions';
import type { ProjectInstructionSizesWire } from '../teams.types';
import { InstructionSizesService } from './instruction-sizes.service';

/**
 * What a run in one project carries before its prompt, per CLI: the project's
 * own text and the memory index a run there would snapshot, composed by each
 * adapter. In the teams module because the projects module is imported by the
 * memory module this reads.
 */
@Injectable()
export class ProjectInstructionSizesService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly memory: MemoryService,
    private readonly instructionSizes: InstructionSizesService,
  ) {}

  async measure(
    projectId: string,
    settings: { customInstructions?: string; replyLanguage?: string },
  ): Promise<ProjectInstructionSizesWire> {
    const project = await this.projects.get(projectId);
    const { memoryIndex } = await this.memory.runSnapshot({
      taskId: null,
      cwd: project.folder,
      projectId: project.id,
    });
    return this.instructionSizes.measureProject({
      customInstructions: settings.customInstructions,
      replyLanguage: settings.replyLanguage,
      projectInstructions: projectInstructionsText(project) ?? undefined,
      memoryIndex: memoryIndex ?? undefined,
    });
  }
}
