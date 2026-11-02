import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';
import { ZodResponse } from 'nestjs-zod';

import type { GoalsWriteOutcome, RunGoalsWire } from '../chat.types';
import {
  CloseRunGoalDto,
  CreateRunGoalDto,
  EditRunGoalDto,
  RunGoalsDto,
} from '../dto/chat.dto';
import { GoalsService } from '../services/goals.service';

/**
 * The user's own hand on a run's goals: list, add, edit, close and reopen.
 * Open to paired devices, like the rest of a chat. Every write is the user's.
 */
@Controller('v1/chats/:runId/goals')
@ApiTags('chats')
@ApiBearerAuth()
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @ApiOperation({ operationId: 'listRunGoals' })
  @ZodResponse({ status: 200, type: RunGoalsDto })
  async list(@Param('runId') runId: string): Promise<RunGoalsWire> {
    const goals = await this.goals.list(runId);
    if (goals === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run ${runId}`);
    }
    return { goals };
  }

  @Post()
  @ApiOperation({ operationId: 'addRunGoal' })
  @ZodResponse({ status: 201, type: RunGoalsDto })
  async add(
    @Param('runId') runId: string,
    @Body() body: CreateRunGoalDto,
  ): Promise<RunGoalsWire> {
    return goalsOrThrow(
      await this.goals.add(runId, { kind: 'user' }, [
        { text: body.text, source: 'user' },
      ]),
    );
  }

  @Patch(':goalId')
  @ApiOperation({ operationId: 'editRunGoal' })
  @ZodResponse({ status: 200, type: RunGoalsDto })
  async edit(
    @Param('runId') runId: string,
    @Param('goalId') goalId: string,
    @Body() body: EditRunGoalDto,
  ): Promise<RunGoalsWire> {
    return goalsOrThrow(
      await this.goals.update(runId, { kind: 'user' }, goalId, body.text),
    );
  }

  @Post(':goalId/close')
  @ApiOperation({ operationId: 'closeRunGoal' })
  @ZodResponse({ status: 201, type: RunGoalsDto })
  async close(
    @Param('runId') runId: string,
    @Param('goalId') goalId: string,
    @Body() body: CloseRunGoalDto,
  ): Promise<RunGoalsWire> {
    return goalsOrThrow(
      await this.goals.close(
        runId,
        { kind: 'user' },
        goalId,
        body.status,
        body.evidence,
      ),
    );
  }

  @Post(':goalId/reopen')
  @ApiOperation({ operationId: 'reopenRunGoal' })
  @ZodResponse({ status: 201, type: RunGoalsDto })
  async reopen(
    @Param('runId') runId: string,
    @Param('goalId') goalId: string,
  ): Promise<RunGoalsWire> {
    return goalsOrThrow(
      await this.goals.reopen(runId, { kind: 'user' }, goalId),
    );
  }
}

function goalsOrThrow(outcome: GoalsWriteOutcome): RunGoalsWire {
  if (outcome.status === 'ok') {
    return { goals: outcome.goals };
  }
  switch (outcome.code) {
    case 'RUN_NOT_FOUND':
    case 'GOAL_NOT_FOUND':
      throw new NotFoundException(outcome.code, outcome.reason);
    case 'GOAL_CLOSED':
    case 'GOAL_OPEN':
      throw new ConflictException(outcome.code, outcome.reason);
    default:
      throw new BadRequestException(outcome.code, outcome.reason);
  }
}
