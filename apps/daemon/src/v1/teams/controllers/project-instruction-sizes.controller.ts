import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  MeasureProjectInstructionSizesDto,
  ProjectInstructionSizesDto,
} from '../dto/project-instruction-sizes.dto';
import { ProjectInstructionSizesService } from '../services/project-instruction-sizes.service';
import type { ProjectInstructionSizesWire } from '../teams.types';

@Controller('v1/projects')
@ApiTags('projects')
@ApiBearerAuth()
export class ProjectInstructionSizesController {
  constructor(private readonly sizes: ProjectInstructionSizesService) {}

  @Post(':projectId/instruction-sizes')
  @ApiOperation({ operationId: 'measureProjectInstructionSizes' })
  @ZodResponse({ status: 200, type: ProjectInstructionSizesDto })
  measure(
    @Param('projectId') projectId: string,
    @Body() dto: MeasureProjectInstructionSizesDto,
  ): Promise<ProjectInstructionSizesWire> {
    return this.sizes.measure(projectId, dto);
  }
}
