import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateProjectDto,
  ProjectDeletedDto,
  ProjectDto,
  UpdateProjectDto,
} from '../dto/project.dto';
import type { ProjectWire } from '../projects.types';
import { ProjectsService } from '../services/projects.service';

/**
 * Projects — a folder and the standing answers for the work done in it
 * (token-gated by the global LoopbackTokenGuard).
 */
@Controller('v1/projects')
@ApiTags('projects')
@ApiBearerAuth()
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({ operationId: 'listProjects' })
  @ZodResponse({ status: 200, type: [ProjectDto] })
  list(): Promise<ProjectWire[]> {
    return this.projects.list();
  }

  @Post()
  @ApiOperation({ operationId: 'createProject' })
  @ZodResponse({ status: 201, type: ProjectDto })
  create(@Body() dto: CreateProjectDto): Promise<ProjectWire> {
    return this.projects.create(dto);
  }

  @Get(':projectId')
  @ApiOperation({ operationId: 'readProject' })
  @ZodResponse({ status: 200, type: ProjectDto })
  read(@Param('projectId') projectId: string): Promise<ProjectWire> {
    return this.projects.get(projectId);
  }

  @Patch(':projectId')
  @ApiOperation({ operationId: 'updateProject' })
  @ZodResponse({ status: 200, type: ProjectDto })
  update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ): Promise<ProjectWire> {
    return this.projects.update(projectId, dto);
  }

  /**
   * Deletes the project AND its tasks — unlike a sidebar group, which releases
   * its runs. A board has nowhere to release cards to.
   */
  @Delete(':projectId')
  @ApiOperation({ operationId: 'deleteProject' })
  @ZodResponse({ status: 200, type: ProjectDeletedDto })
  remove(
    @Param('projectId') projectId: string,
  ): Promise<{ deleted: boolean; tasksRemoved: number }> {
    return this.projects.remove(projectId);
  }
}
