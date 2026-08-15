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

import type { RunGroupWire } from '../chat.types';
import {
  CreateRunGroupDto,
  ReorderRunGroupsDto,
  RunGroupDeletedDto,
  RunGroupDto,
  UpdateRunGroupDto,
} from '../dto/run-group.dto';
import { RunGroupsService } from '../services/run-groups.service';

/**
 * The sidebar's groups (token-gated by the global LoopbackTokenGuard).
 *
 * A group holds runs of BOTH kinds — the sidebar lists chats and workflow runs
 * together — which is why this is `/v1/groups` and not a branch of `/v1/chats`.
 * Filing one run is the exception and lives on the run's own route
 * (`PUT /v1/chats/:runId/group`), where the response is the run.
 */
@Controller('v1/groups')
@ApiTags('groups')
@ApiBearerAuth()
export class RunGroupsController {
  constructor(private readonly groups: RunGroupsService) {}

  @Get()
  @ApiOperation({ operationId: 'listRunGroups' })
  @ZodResponse({ status: 200, type: [RunGroupDto] })
  list(): Promise<RunGroupWire[]> {
    return this.groups.list();
  }

  @Post()
  @ApiOperation({ operationId: 'createRunGroup' })
  @ZodResponse({ status: 201, type: RunGroupDto })
  create(@Body() dto: CreateRunGroupDto): Promise<RunGroupWire> {
    return this.groups.create(dto);
  }

  @Patch(':groupId')
  @ApiOperation({ operationId: 'updateRunGroup' })
  @ZodResponse({ status: 200, type: RunGroupDto })
  update(
    @Param('groupId') groupId: string,
    @Body() dto: UpdateRunGroupDto,
  ): Promise<RunGroupWire> {
    return this.groups.update(groupId, dto);
  }

  /**
   * Set the sidebar order from the ids the client is now showing — what a drag
   * produces. Declared BEFORE the `:groupId` routes so `reorder` is read as
   * this path and never as a group id.
   */
  @Post('reorder')
  @ApiOperation({ operationId: 'reorderRunGroups' })
  @ZodResponse({ status: 200, type: [RunGroupDto] })
  reorder(@Body() dto: ReorderRunGroupsDto): Promise<RunGroupWire[]> {
    return this.groups.reorder(dto.ids);
  }

  /**
   * Deletes the GROUP, never its chats: the runs filed under it are released
   * back to the loose list and keep every item they hold.
   */
  @Delete(':groupId')
  @ApiOperation({ operationId: 'deleteRunGroup' })
  @ZodResponse({ status: 200, type: RunGroupDeletedDto })
  remove(
    @Param('groupId') groupId: string,
  ): Promise<{ deleted: boolean; released: number }> {
    return this.groups.remove(groupId);
  }
}
