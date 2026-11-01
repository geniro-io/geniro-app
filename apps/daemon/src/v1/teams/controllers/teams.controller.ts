import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { cameViaRemote } from '../../../auth/remote-marker';
import type {
  ActionPressWire,
  ItemWire,
  RunWire,
  ThreadAnalysisWire,
} from '../../agents/chat.types';
import {
  ActionPressDto,
  AnalyzeTeamDto,
  CancelledDto,
  ItemDto,
  ListChatsQueryDto,
  PressActionDto,
  RunDto,
  SendMessageDto,
  ThreadAnalysisDto,
} from '../../agents/dto/chat.dto';
import { runListPageOf } from '../../agents/utils/run-list-page';
import {
  CreateTeamDto,
  ExportedDto,
  ExportTeamDto,
  ImportTeamDto,
  InstructionSizesDto,
  MeasureInstructionSizesDto,
  MoveTeamRunStageDto,
  NodeStateDto,
  ResetWakesCancelledDto,
  RunTeamDto,
  RunTeamSnapshotDto,
  SaveTeamDto,
  StageMoveResultDto,
  StartTeamChatDto,
  TeamChatsDiscardedDto,
  TeamDeletedDto,
  TeamFileDto,
  TeamSummaryDto,
} from '../dto/teams.dto';
import { GraphExecutorService } from '../services/graph-executor.service';
import { InstructionSizesService } from '../services/instruction-sizes.service';
import { RunTeamService } from '../services/run-team.service';
import { StageWakeService } from '../services/stage-wake.service';
import { TeamActionsService } from '../services/team-actions.service';
import { TeamAnalysisService } from '../services/team-analysis.service';
import { TeamChatService } from '../services/team-chat.service';
import { TeamStoreService } from '../services/team-store.service';
import type {
  InstructionSizesWire,
  NodeStateWire,
  ResetWakesCancelled,
  RunTeamSnapshotWire,
  StageMoveResultWire,
  TeamSummary,
  TeamWire,
} from '../teams.types';

/**
 * Loopback team REST surface (token-gated by the global
 * LoopbackTokenGuard): library CRUD over the `*.team.yaml` files plus the
 * run endpoints that hand a team to the DAG executor. The static `runs`
 * routes are declared before the `:slug` routes so Nest never captures "runs"
 * as a slug. Run transcripts replay over the existing
 * `GET /v1/chats/:runId/items` history read (items are run-scoped, not
 * team-scoped) and stream over `/ws`.
 */
@Controller('v1/teams')
@ApiTags('teams')
@ApiBearerAuth()
export class TeamsController {
  constructor(
    private readonly store: TeamStoreService,
    private readonly executor: GraphExecutorService,
    private readonly runTeams: RunTeamService,
    private readonly teamChats: TeamChatService,
    private readonly actions: TeamActionsService,
    private readonly instructionSizes: InstructionSizesService,
    private readonly teamAnalyses: TeamAnalysisService,
    private readonly stageWakes: StageWakeService,
  ) {}

  /**
   * `ListChatsQueryDto` rather than a query type of this module's own: the
   * scope is ONE vocabulary — the sidebar lists chats and team runs
   * together and sends both halves the same answer — and a second spelling of
   * it is how the two would come to disagree about what `all` means.
   */
  @Get('runs')
  @ApiOperation({ operationId: 'listTeamRuns' })
  @ZodResponse({ status: 200, type: [RunDto] })
  listRuns(@Query() query: ListChatsQueryDto): Promise<RunWire[]> {
    return this.executor.listRuns(
      query.scope ?? 'active',
      runListPageOf(query),
    );
  }

  @Get('runs/:runId/nodes')
  @ApiOperation({ operationId: 'listTeamRunNodes' })
  @ZodResponse({ status: 200, type: [NodeStateDto] })
  getRunNodes(@Param('runId') runId: string): Promise<NodeStateWire[]> {
    return this.executor.getNodeStates(runId);
  }

  /**
   * The team THIS run runs — the copy it keeps, never the library's current
   * one, so editing a team changes no run already made from it. A run made
   * before runs kept a copy takes one on this first read.
   */
  @Get('runs/:runId/team')
  @ApiOperation({ operationId: 'getTeamRunSnapshot' })
  @ZodResponse({ status: 200, type: RunTeamSnapshotDto })
  getRunTeam(@Param('runId') runId: string): Promise<RunTeamSnapshotWire> {
    return this.runTeams.snapshotOfRun(runId);
  }

  @Post('runs/:runId/cancel')
  @ApiOperation({ operationId: 'cancelTeamRun' })
  @ZodResponse({ status: 200, type: CancelledDto })
  cancelRun(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.executor.cancel(runId);
  }

  /**
   * Call off the continues geniro promised this run at a usage-limit reset —
   * the user would rather pick the team up themselves.
   */
  @Post('runs/:runId/reset-wakes/cancel')
  @ApiOperation({ operationId: 'cancelTeamRunResetWakes' })
  @ZodResponse({ status: 200, type: ResetWakesCancelledDto })
  cancelResetWakes(
    @Param('runId') runId: string,
  ): Promise<ResetWakesCancelled> {
    return this.executor.cancelResetWakes(runId);
  }

  /**
   * A follow-up message for a team run — it goes to the agents the run's
   * trigger feeds, as though the trigger had fired again with this text.
   * Answers with the persisted message row, like the chat route's twin.
   */
  @Post('runs/:runId/messages')
  @ApiOperation({ operationId: 'sendTeamRunMessage' })
  @ZodResponse({ status: 201, type: ItemDto })
  sendMessage(
    @Param('runId') runId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.executor.sendMessage(
      runId,
      dto.text,
      dto.images,
      dto.clientMessageId,
    );
  }

  @Post('runs/:runId/stages')
  @ApiOperation({ operationId: 'moveTeamRunStage' })
  @ZodResponse({ status: 201, type: StageMoveResultDto })
  moveStage(
    @Param('runId') runId: string,
    @Body() dto: MoveTeamRunStageDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<StageMoveResultWire> {
    return this.stageWakes.userMove(
      runId,
      {
        action: dto.action,
        stage: dto.stage,
        ...(dto.next !== undefined ? { next: dto.next } : {}),
        text: dto.text,
      },
      cameViaRemote(headers) ? 'remote' : 'desktop',
      dto.expectedRev,
    );
  }

  /**
   * A press of an agent's button in a team run: a message action goes to
   * the agents the run's trigger feeds, prefixed with who published it when
   * that was another agent. Refusals are the chat route's twin, the run's own
   * `RUN_BUSY` included, after which the same press may be repeated.
   */
  @Post('runs/:runId/actions/:seq/press')
  @ApiOperation({ operationId: 'pressTeamAction' })
  @ApiParam({ name: 'seq', type: Number })
  @ZodResponse({ status: 201, type: ActionPressDto })
  pressAction(
    @Param('runId') runId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: PressActionDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<ActionPressWire> {
    return this.actions.press(
      runId,
      seq,
      dto.clientMessageId,
      cameViaRemote(headers) ? 'remote' : 'desktop',
    );
  }

  /** Takes an agent's button off a team run; no agent is told. */
  @Post('runs/:runId/actions/:seq/dismiss')
  @ApiOperation({ operationId: 'dismissTeamAction' })
  @ApiParam({ name: 'seq', type: Number })
  @ZodResponse({ status: 201, type: ActionPressDto })
  dismissAction(
    @Param('runId') runId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<ActionPressWire> {
    return this.actions.dismiss(
      runId,
      seq,
      cameViaRemote(headers) ? 'remote' : 'desktop',
    );
  }

  /**
   * A message straight to the callee of one RUNNING call, past its caller.
   * 409 `CALL_NOT_RUNNING` once the call has settled or the node is not its
   * callee, `CALL_MESSAGE_REFUSED` when the callee's CLI cannot take a message
   * mid-turn.
   */
  @Post('runs/:runId/nodes/:nodeId/calls/:callId/messages')
  @ApiOperation({ operationId: 'sendTeamCallMessage' })
  @ZodResponse({ status: 201, type: ItemDto })
  sendCallMessage(
    @Param('runId') runId: string,
    @Param('nodeId') nodeId: string,
    @Param('callId') callId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.executor.sendCallMessage(
      runId,
      nodeId,
      callId,
      dto.text,
      dto.images,
      dto.clientMessageId,
    );
  }

  /**
   * Destructive and irreversible — the team-run half of the chats
   * sidebar's delete (its chat rows go to `DELETE /v1/chats/:runId`). The
   * LIBRARY team is untouched: this deletes one run's history, not the
   * graph it ran.
   */
  @Delete('runs/:runId')
  @ApiOperation({ operationId: 'deleteTeamRun' })
  @ZodResponse({ status: 200, type: TeamDeletedDto })
  deleteRun(@Param('runId') runId: string): Promise<{ deleted: boolean }> {
    return this.executor.deleteRun(runId);
  }

  @Get()
  @ApiOperation({ operationId: 'listTeams' })
  @ZodResponse({ status: 200, type: [TeamSummaryDto] })
  list(): Promise<TeamSummary[]> {
    return this.store.list();
  }

  @Post()
  @ApiOperation({ operationId: 'createTeam' })
  @ZodResponse({ status: 201, type: TeamFileDto })
  create(@Body() dto: CreateTeamDto): Promise<TeamWire> {
    return this.store.create(dto.team, dto.slug);
  }

  @Post('import')
  @ApiOperation({ operationId: 'importTeam' })
  @ZodResponse({ status: 201, type: TeamFileDto })
  import(@Body() dto: ImportTeamDto): Promise<TeamWire> {
    return this.store.importFrom(dto.path);
  }

  @Post('instruction-sizes')
  @ApiOperation({ operationId: 'measureInstructionSizes' })
  @ZodResponse({ status: 200, type: InstructionSizesDto })
  measureInstructionSizes(
    @Body() dto: MeasureInstructionSizesDto,
  ): InstructionSizesWire {
    return this.instructionSizes.measure(dto);
  }

  @Get(':slug')
  @ApiOperation({ operationId: 'getTeam' })
  @ZodResponse({ status: 200, type: TeamFileDto })
  get(@Param('slug') slug: string): Promise<TeamWire> {
    return this.store.get(slug);
  }

  @Put(':slug')
  @ApiOperation({ operationId: 'saveTeam' })
  @ZodResponse({ status: 200, type: TeamFileDto })
  save(
    @Param('slug') slug: string,
    @Body() dto: SaveTeamDto,
  ): Promise<TeamWire> {
    return this.store.save(slug, dto.team, dto.baseHash);
  }

  /**
   * Through `TeamChatService` rather than the store, because deleting a
   * team also destroys the builder chat about it — a conversation whose
   * agent still carries a brief naming a file that is gone.
   */
  @Delete(':slug')
  @ApiOperation({ operationId: 'deleteTeam' })
  @ZodResponse({ status: 200, type: TeamDeletedDto })
  async delete(@Param('slug') slug: string): Promise<{ deleted: boolean }> {
    await this.teamChats.deleteTeam(slug);
    return { deleted: true };
  }

  /**
   * The builder chat panel's conversation about this team — the one
   * already open, or a new one started with the composer's chips. The chips
   * are read only when there is nothing to reopen; changing an open chat's
   * agent or model is `PATCH /v1/chats/:runId`.
   */
  @Post(':slug/chat')
  @ApiOperation({ operationId: 'openTeamChat' })
  @ZodResponse({ status: 201, type: RunDto })
  openChat(
    @Param('slug') slug: string,
    @Body() dto: StartTeamChatDto,
  ): Promise<RunWire> {
    return this.teamChats.open(slug, dto);
  }

  /**
   * **Destructive and irreversible**: throw away the conversation about this
   * team so the next open starts a fresh one. The team itself is
   * untouched.
   */
  @Delete(':slug/chat')
  @ApiOperation({ operationId: 'discardTeamChat' })
  @ZodResponse({ status: 200, type: TeamChatsDiscardedDto })
  discardChat(@Param('slug') slug: string): Promise<{ deleted: number }> {
    return this.teamChats.discard(slug);
  }

  /**
   * This team's analysis — the chat its "Analyze & improve" popup opens —
   * or `analysis: null` while it has none. 404 for a team the library
   * does not hold.
   */
  @Get(':slug/analysis')
  @ApiOperation({ operationId: 'getTeamAnalysis' })
  @ZodResponse({ status: 200, type: ThreadAnalysisDto })
  async getAnalysis(@Param('slug') slug: string): Promise<ThreadAnalysisWire> {
    return { analysis: await this.teamAnalyses.find(slug) };
  }

  /**
   * Start this team's analysis ("Analyze & improve") over its `runs`
   * newest runs, replacing the one it had. 409 `ANALYSIS_NO_RUNS` for a
   * team never run, `ANALYSIS_FOLDER_GONE` until a folder that exists is
   * sent as `cwd`.
   */
  @Post(':slug/analyses')
  @ApiOperation({ operationId: 'analyzeTeam' })
  @ZodResponse({ status: 201, type: RunDto })
  analyze(
    @Param('slug') slug: string,
    @Body() dto: AnalyzeTeamDto,
  ): Promise<RunWire> {
    return this.teamAnalyses.start(slug, dto);
  }

  @Post(':slug/export')
  @ApiOperation({ operationId: 'exportTeam' })
  @ZodResponse({ status: 200, type: ExportedDto })
  async export(
    @Param('slug') slug: string,
    @Body() dto: ExportTeamDto,
  ): Promise<{ exported: boolean }> {
    await this.store.exportTo(slug, dto.path);
    return { exported: true };
  }

  @Post(':slug/runs')
  @ApiOperation({ operationId: 'startTeamRun' })
  @ZodResponse({ status: 201, type: RunDto })
  run(@Param('slug') slug: string, @Body() dto: RunTeamDto): Promise<RunWire> {
    return this.executor.startRunBySlug(slug, dto);
  }
}
