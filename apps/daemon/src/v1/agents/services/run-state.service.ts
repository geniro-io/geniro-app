import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { Item } from '../../runs/entity/item.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import type { ItemWire, RunStateWire, TurnEnding } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { rowsWithId, workflowEdgeRows } from '../utils/history-anchors';
import { itemToWire } from '../utils/item-wire';
import { parseJsonColumn, payloadString } from '../utils/json-util';
import { foldRunCalls, foldRunDelegates } from '../utils/run-state-folds';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { ApprovalRegistry } from './approval-registry';
import { ChatShellsService } from './chat-shells.service';

/**
 * What a run holds as a whole, for the readouts that must not depend on how
 * much of the transcript a client has loaded — `GET /v1/chats/:runId/state`.
 *
 * A COMPOSITION of reads the run already answers elsewhere, never a second
 * store: the open cards are the approval registry's, the shells are
 * `ChatShellsService`'s, and the rest is folded from the rows each question is
 * about. Kinds a run holds a handful of are read by the `(runId, kind, seq)`
 * index. The tool rows cost JSON-path scans: one over the run's tool calls by
 * NAME, one over its replies by id, a third over its tool calls by id only
 * when it launched a dynamic workflow, and the shell fold's own while a
 * command is open.
 */
@Injectable()
export class RunStateService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly approvals: ApprovalRegistry,
    private readonly shells: ChatShellsService,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  async read(runId: string): Promise<RunStateWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const wire = (rows: readonly Item[]): ItemWire[] => rows.map(itemToWire);
    const runSettled = isTerminalRunStatus(run.status);

    // The cards the registry still holds, read back as the rows they were
    // persisted as — the client draws a card from its row, and the registry
    // alone is what says the card is still open.
    const pendingIds = this.approvals
      .listByRun(runId)
      .map((entry) => entry.requestId);
    const openRequests =
      pendingIds.length === 0
        ? []
        : wire(
            await this.itemDao.rowsByPayloadId(
              runId,
              ['approval_request'],
              pendingIds,
              undefined,
              em,
            ),
          );

    const calls = foldRunCalls(
      wire(
        await this.itemDao.rowsOfKinds(
          runId,
          ['call_started', 'call_result'],
          undefined,
          em,
        ),
      ),
      wire(await this.itemDao.callHandOffRows(runId, undefined, em)),
    );

    const declarations = wire(
      await this.itemDao.rowsOfKinds(runId, ['subagent_info'], undefined, em),
    );
    const announcements = wire(
      await this.itemDao.rowsOfKinds(runId, ['workflow_info'], undefined, em),
    );
    const { launchNames, artifactNames } = this.toolNames();
    const named = wire(
      await this.itemDao.toolCallsNamed(
        runId,
        [...launchNames.map((name) => name.toLowerCase()), ...artifactNames],
        em,
      ),
    );
    // The read is case-blind; a delegation is then the CLI's exact spelling,
    // so another CLI's command that happens to be called `task` is not one.
    const delegationCalls = named.filter((row) =>
      launchNames.includes(payloadString(row.payload, 'name') ?? ''),
    );
    const artifactCalls = named.filter((row) =>
      artifactNames.includes(toolNameOf(row)),
    );
    const delegateIds = idsOf([...declarations, ...delegationCalls]);
    const workflowIds = idsOf(announcements);
    const artifactIds = idsOf(artifactCalls);

    const replies = wire(
      await this.itemDao.rowsByPayloadId(
        runId,
        ['tool_result'],
        [...new Set([...delegateIds, ...workflowIds, ...artifactIds])],
        undefined,
        em,
      ),
    );
    const workflowLaunches =
      workflowIds.size === 0
        ? []
        : wire(
            await this.itemDao.rowsByPayloadId(
              runId,
              ['tool_call'],
              [...workflowIds],
              undefined,
              em,
            ),
          );

    const delegateReplies = rowsWithId(replies, delegateIds);
    const delegates = foldRunDelegates({
      declarations,
      launches: delegationCalls,
      replies: delegateReplies,
      runSettled,
      endings: runSettled
        ? []
        : await this.endingsAfterUnanswered(
            runId,
            [...delegationCalls, ...declarations],
            idsOf(delegateReplies),
            em,
          ),
    });
    const workflowRows = [
      ...workflowEdgeRows(announcements, workflowIds),
      ...workflowLaunches,
      ...rowsWithId(replies, workflowIds),
    ].sort((a, b) => a.seq - b.seq);
    const artifactRows = [
      ...artifactCalls,
      ...rowsWithId(replies, artifactIds),
    ].sort((a, b) => a.seq - b.seq);

    // A workflow's turns belong to its nodes, each with a clock of its own on
    // `node_state`; only a chat's turn is the RUN's.
    const turnStartedAt =
      run.workflowId === null && run.status === 'running'
        ? ((await this.itemDao.openTurnStartedAt(runId, em))?.toISOString() ??
          null)
        : null;

    return {
      openRequests,
      calls,
      delegates,
      workflowRows,
      artifactRows,
      shells: (await this.shells.read(runId)).shells,
      turnStartedAt,
    };
  }

  /**
   * Every adapter's delegate-launching tool names, as the CLI spells them, and
   * its artifact tool names, lowercased — the run may hold rows of any CLI a
   * workflow mixed.
   */
  private toolNames(): { launchNames: string[]; artifactNames: string[] } {
    const launchNames = new Set<string>();
    const artifactNames = new Set<string>();
    for (const adapter of this.adapters.all().values()) {
      const config = adapter.getConfig();
      config.subagents.launchToolNames.forEach((name) => launchNames.add(name));
      config.artifactToolNames.forEach((name) =>
        artifactNames.add(name.toLowerCase()),
      );
    }
    return { launchNames: [...launchNames], artifactNames: [...artifactNames] };
  }

  /**
   * The run's turn endings after its oldest unanswered delegate, in one read —
   * none when every delegate was answered.
   */
  private async endingsAfterUnanswered(
    runId: string,
    rows: readonly ItemWire[],
    answered: ReadonlySet<string>,
    em: EntityManager,
  ): Promise<TurnEnding[]> {
    let oldest: number | null = null;
    for (const row of rows) {
      const id = idOf(row);
      if (id !== null && !answered.has(id)) {
        oldest = oldest === null ? row.seq : Math.min(oldest, row.seq);
      }
    }
    if (oldest === null) {
      return [];
    }
    return (await this.itemDao.turnEndingsAfter(runId, oldest, em)).map(
      (row) => ({
        seq: row.seq,
        nodeId: row.nodeId,
        callId: payloadString(parseJsonColumn(row.payload), 'callId'),
      }),
    );
  }
}

function toolNameOf(row: ItemWire): string {
  return payloadString(row.payload, 'name')?.toLowerCase() ?? '';
}

function idOf(row: ItemWire): string | null {
  return payloadString(row.payload, 'id');
}

function idsOf(rows: readonly ItemWire[]): Set<string> {
  return new Set(rows.map(idOf).filter((id): id is string => id !== null));
}
