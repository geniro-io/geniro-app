import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { DAEMON_VERSION } from '../../../utils/daemon-version';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import {
  CHAT_EXPORT_FORMAT_VERSION,
  type ChatExportNodeWire,
  type ChatExportRunWire,
  type ChatExportWire,
} from '../chat.types';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { readModelParameters } from '../utils/model-parameters';
import { ChatService } from './chat.service';
import { ChatMetricsService } from './chat-metrics.service';

/**
 * One conversation, assembled into a file the user can keep.
 *
 * It exists because the app had nowhere to hand a whole thread from. What a
 * reader needs to diagnose a turn is spread across four tables and three of the
 * run's own columns — the transcript with its raw tool payloads, which node ran
 * on which CLI, what the thread cost, and the settings the turns actually ran
 * under — and the one place all of it is reachable at once is here.
 *
 * It COMPOSES and reads nothing itself, which is the rule the module's other
 * services follow: the transcript comes from {@link ChatService.getHistory} and
 * the spend from {@link ChatMetricsService.readTotals}, so an exported item is
 * byte-for-byte the item the history route serves and an exported total is the
 * figure the header shows. A second projection here is how the file and the
 * screen would come to disagree about the same conversation.
 *
 * Kind-BLIND, like the history and rename routes it sits beside: a workflow
 * run's transcript is worth exporting for the same reason a chat's is, and the
 * `nodes` array is where that kind carries most of its evidence. Only the
 * routes that COMMAND an engine have to know which one they are talking to.
 */
@Injectable()
export class ChatExportService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly chats: ChatService,
    private readonly metrics: ChatMetricsService,
  ) {}

  async export(runId: string): Promise<ChatExportWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const nodes = await this.nodeStateDao.listByRun(runId, em);
    // No `window`, deliberately: this is the WHOLE transcript, not the page a
    // client has scrolled through. An export missing its middle is worse than
    // no export, because nothing about the file says a part is absent.
    const items = await this.chats.getHistory(runId);
    return {
      formatVersion: CHAT_EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      daemonVersion: DAEMON_VERSION,
      run: exportRun(run),
      totals: await this.metrics.readTotals(runId),
      nodes: nodes.map(exportNode),
      items,
    };
  }
}

/**
 * The run row for the file.
 *
 * `lastMetricsReading` is passed through as PARSED JSON where it parses and as
 * null where it does not, rather than as the raw string the column holds: the
 * whole document is JSON, and a field that is itself an escaped JSON string is
 * one a reader has to unwrap by hand. Unreadable is reported as absent on the
 * rule {@link readModelParameters} follows — a column that cannot be read must
 * not fail the export of the conversation around it.
 */
function exportRun(run: Run): ChatExportRunWire {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    title: run.title,
    agentKind: run.agentKind,
    cwd: run.cwd,
    model: run.model,
    approval: run.approval,
    effort: run.effort,
    contextWindow: run.contextWindow,
    modelParameters: readModelParameters(run.modelParameters),
    contextTokens: run.contextTokens,
    contextWindowTokens: run.contextWindowTokens,
    configDir: run.configDir,
    groupId: run.groupId,
    customInstructions: run.customInstructions,
    cursorMaxMode: run.cursorMaxMode,
    lastMetricsReading: parseOrNull(run.lastMetricsReading),
    pendingContext: run.pendingContext,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function exportNode(node: NodeState): ChatExportNodeWire {
  return {
    nodeId: node.nodeId,
    status: node.status,
    agentKind: node.agentKind,
    model: node.model,
    agentSessionId: node.agentSessionId,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    error: node.error,
  };
}

function parseOrNull(raw: string | null): unknown {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
