import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { claudeCredentialEnv } from '../../agents/utils/child-env';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { TerminalSessionWire } from '../terminals.types';
import { terminalCommand } from '../utils/terminal-command';
import { PtyService } from './pty.service';

/**
 * Resolves "open a terminal for this run/node" into a concrete PTY spawn: the
 * run supplies the cwd, the node (workflow YAML for graph runs, the run row
 * itself for chats) supplies the agent kind, and the CLI session id comes from
 * `node_state` (the node's latest session) — or, when the caller passes an
 * explicit `sessionId`, from a specific thread of the node (a call thread's
 * resume id recorded on its `call_result` item), so every thread of an agent
 * can be mirrored, not just the most recent one.
 */
@Injectable()
export class TerminalsService {
  /**
   * In-flight creates keyed by the mirror target — `runId:nodeId:sessionId`
   * (the RESOLVED session). The daemon owns the one-running-mirror-per-target
   * invariant: without this single-flight, two concurrent POSTs (a
   * double-click) both miss {@link PtyService.findRunning} during their awaits
   * and spawn two `claude --resume <same session>` REPLs — the second
   * invisible to the UI until daemon shutdown.
   */
  private readonly pending = new Map<string, Promise<TerminalSessionWire>>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly workflowStore: WorkflowStoreService,
    private readonly pty: PtyService,
  ) {}

  /**
   * Idempotent per (run, node, session): a still-running mirror of the same
   * CLI session is returned instead of spawning a duplicate; concurrent calls
   * coalesce onto one create. Distinct threads of one node are distinct
   * targets — each call thread gets its own mirror.
   */
  async createForRun(input: {
    runId: string;
    nodeId?: string | null;
    sessionId?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSessionWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(input.runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${input.runId}`);
    }
    if (!run.workflowId && input.nodeId != null) {
      throw new BadRequestException(
        'TERMINAL_NODE_UNEXPECTED',
        `chat run ${run.id} does not accept a nodeId`,
      );
    }
    const nodeId = run.workflowId ? (input.nodeId ?? null) : null;
    const { agentKind, stateNodeId, wireNodeId } = await this.resolveNode(
      run,
      nodeId,
      em,
    );
    const resumeSessionId =
      input.sessionId ??
      (await this.nodeStateDao.getByRunNode(run.id, stateNodeId, em))
        ?.agentSessionId ??
      null;
    const key = `${input.runId}:${nodeId ?? ''}:${resumeSessionId ?? ''}`;
    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }
    const create = this.doCreateForRun(
      { ...input, nodeId: wireNodeId, agentKind, resumeSessionId },
      run,
    ).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, create);
    return create;
  }

  private async doCreateForRun(
    input: {
      runId: string;
      nodeId: string | null;
      agentKind: AgentKind;
      resumeSessionId: string | null;
      cols?: number;
      rows?: number;
    },
    run: Run,
  ): Promise<TerminalSessionWire> {
    const existing = this.pty.findRunning(
      input.runId,
      input.nodeId,
      input.resumeSessionId,
    );
    if (existing) {
      return existing;
    }
    if (!run.cwd) {
      throw new BadRequestException(
        'TERMINAL_NO_CWD',
        `run ${run.id} has no working directory to open a terminal in`,
      );
    }
    const cwd = resolveValidCwd(run.cwd);
    const { command, args } = terminalCommand(
      input.agentKind,
      input.resumeSessionId,
    );
    return this.pty.create({
      runId: run.id,
      nodeId: input.nodeId,
      resumeSessionId: input.resumeSessionId,
      command,
      args,
      cwd,
      cols: input.cols,
      rows: input.rows,
      // Terminal mirrors are claude-only in v1 (terminalCommand rejects
      // cursor-agent), so every session gets the claude-child credential
      // re-injection buildChildEnv otherwise strips.
      env: claudeCredentialEnv(),
    });
  }

  /**
   * A chat run carries its agent kind on the row and keys `node_state` under
   * the single-agent constant; a workflow run's node kind comes from the
   * `agent_kind` stamped on its `node_state` row at turn start — run history,
   * immune to later workflow-YAML edits. Only legacy rows (stamped before the
   * column existed) fall back to the CURRENT YAML definition.
   */
  private async resolveNode(
    run: Run,
    nodeId: string | null,
    em: EntityManager,
  ): Promise<{
    agentKind: AgentKind;
    stateNodeId: string;
    wireNodeId: string | null;
  }> {
    if (!run.workflowId) {
      if (!run.agentKind) {
        throw new BadRequestException(
          'TERMINAL_NO_AGENT',
          `run ${run.id} has no agent kind`,
        );
      }
      return {
        agentKind: run.agentKind,
        stateNodeId: SINGLE_AGENT_NODE,
        wireNodeId: null,
      };
    }
    if (!nodeId) {
      throw new BadRequestException(
        'TERMINAL_NODE_REQUIRED',
        `run ${run.id} is a workflow run — pass the nodeId to mirror`,
      );
    }
    const stamped = (await this.nodeStateDao.getByRunNode(run.id, nodeId, em))
      ?.agentKind;
    if (stamped) {
      return { agentKind: stamped, stateNodeId: nodeId, wireNodeId: nodeId };
    }
    const { workflow } = await this.workflowStore.get(run.workflowId);
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new NotFoundException(
        'NODE_NOT_FOUND',
        `workflow ${run.workflowId} has no node: ${nodeId}`,
      );
    }
    if (node.kind !== 'agent') {
      // Only agent nodes run a CLI session there is anything to mirror of.
      throw new BadRequestException(
        'TERMINAL_NODE_NOT_AGENT',
        `node ${nodeId} is a ${node.kind} node — only agent nodes have a terminal`,
      );
    }
    return { agentKind: node.agent, stateNodeId: nodeId, wireNodeId: nodeId };
  }
}
