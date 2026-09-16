import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateLabelInstructionDto,
  LabelInstructionDeletedDto,
  LabelInstructionDto,
  ListLabelInstructionsQueryDto,
  UpdateLabelInstructionDto,
} from '../dto/label-instruction.dto';
import { LabelInstructionsService } from '../services/label-instructions.service';
import type { LabelInstructionWire } from '../tasks.types';

/**
 * Instructions attached to a task LABEL — pick one from a list or create it,
 * either globally or scoped to one project (token-gated by the global
 * LoopbackTokenGuard).
 */
@Controller('v1/label-instructions')
@ApiTags('labelInstructions')
@ApiBearerAuth()
export class LabelInstructionsController {
  constructor(private readonly labelInstructions: LabelInstructionsService) {}

  @Get()
  @ApiOperation({ operationId: 'listLabelInstructions' })
  @ZodResponse({ status: 200, type: [LabelInstructionDto] })
  list(
    @Query() query: ListLabelInstructionsQueryDto,
  ): Promise<LabelInstructionWire[]> {
    return this.labelInstructions.list(query.projectId);
  }

  @Post()
  @ApiOperation({ operationId: 'createLabelInstruction' })
  @ZodResponse({ status: 201, type: LabelInstructionDto })
  create(
    @Body() dto: CreateLabelInstructionDto,
  ): Promise<LabelInstructionWire> {
    return this.labelInstructions.create(dto);
  }

  @Patch(':instructionId')
  @ApiOperation({ operationId: 'updateLabelInstruction' })
  @ZodResponse({ status: 200, type: LabelInstructionDto })
  update(
    @Param('instructionId') instructionId: string,
    @Body() dto: UpdateLabelInstructionDto,
  ): Promise<LabelInstructionWire> {
    return this.labelInstructions.update(instructionId, dto);
  }

  @Delete(':instructionId')
  @ApiOperation({ operationId: 'deleteLabelInstruction' })
  @ZodResponse({ status: 200, type: LabelInstructionDeletedDto })
  remove(
    @Param('instructionId') instructionId: string,
  ): Promise<{ deleted: boolean }> {
    return this.labelInstructions.remove(instructionId);
  }
}
