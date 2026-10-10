import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { GlobalChatSearchResult } from '../chat-search.types';
import {
  GlobalChatSearchQueryDto,
  GlobalChatSearchResultDto,
} from '../dto/chat-search.dto';
import { GlobalChatSearchService } from '../services/global-chat-search.service';

@Controller('v1/chats')
@ApiTags('chats')
@ApiBearerAuth()
export class ChatSearchController {
  constructor(private readonly search: GlobalChatSearchService) {}

  @Get('search')
  @ApiOperation({ operationId: 'searchAllChats' })
  @ZodResponse({ status: 200, type: GlobalChatSearchResultDto })
  searchAllChats(
    @Query() query: GlobalChatSearchQueryDto,
  ): Promise<GlobalChatSearchResult> {
    return this.search.search(query);
  }
}
