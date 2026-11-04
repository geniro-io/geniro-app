import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { RunWire } from '../../agents/chat.types';
import { RunDto } from '../../agents/dto/chat.dto';
import {
  ProjectChatsDiscardedDto,
  StartProjectChatDto,
} from '../dto/project-chat.dto';
import { ProjectChatService } from '../services/project-chat.service';

@Controller('v1/projects')
@ApiTags('projects')
@ApiBearerAuth()
export class ProjectChatController {
  constructor(private readonly chats: ProjectChatService) {}

  /**
   * The project page's chat panel's conversation — the one already open, or a
   * new one in the project's folder started with the composer's chips.
   */
  @Post(':projectId/chat')
  @ApiOperation({ operationId: 'openProjectChat' })
  @ZodResponse({ status: 201, type: RunDto })
  open(
    @Param('projectId') projectId: string,
    @Body() dto: StartProjectChatDto,
  ): Promise<RunWire> {
    return this.chats.open(projectId, dto);
  }

  /**
   * **Destructive and irreversible**: throw the project's conversation away so
   * the next open starts a fresh one. The project itself is untouched.
   */
  @Delete(':projectId/chat')
  @ApiOperation({ operationId: 'discardProjectChat' })
  @ZodResponse({ status: 200, type: ProjectChatsDiscardedDto })
  discard(@Param('projectId') projectId: string): Promise<{ deleted: number }> {
    return this.chats.discard(projectId);
  }
}
