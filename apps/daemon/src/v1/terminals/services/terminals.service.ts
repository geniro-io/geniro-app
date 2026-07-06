import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
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
 * itself for chats) supplies the agent kind, and `node_state` supplies the CLI
 * session id so the TUI resumes the very session the headless run produced.
 */
@Injectable()
export class TerminalsService {
  /**
   * In-flight creates keyed by `runId:nodeId`. The daemon owns the
   * one-running-mirror-per-target invariant: without this single-flight, two
   * concurrent POSTs (a double-click) both miss {@link PtyService.findRunning}
   * during their awaits and spawn two `claude --resume <same session>` REPLs —
   * the second invisible to the UI until daemon shutdown.
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
   * Idempotent per (run, node): a still-running mirror for the same target is
   * returned instead of spawning a duplicate; concurrent calls coalesce onto
   * one create.
   */
  createForRun(input: {
    runId: string;
    nodeId?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSessionWire> {
    const key = `${input.runId}:${input.nodeId ?? ''}`;
    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }
    const create = this.doCreateForRun(input).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, create);
    return create;
  }

  private async doCreateForRun(input: {
    runId: string;
    nodeId?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSessionWire> {
    const existing = this.pty.findRunning(input.runId, input.nodeId ?? null);
    if (existing) {
      return existing;
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(input.runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${input.runId}`);
    }
    if (!run.cwd) {
      throw new BadRequestException(
        'TERMINAL_NO_CWD',
        `run ${run.id} has no working directory to open a terminal in`,
      );
    }
    const cwd = resolveValidCwd(run.cwd);
    const { agentKind, stateNodeId, wireNodeId } = await this.resolveNode(
      run,
      input.nodeId ?? null,
    );
    const state = await this.nodeStateDao.getByRunNode(run.id, stateNodeId, em);
    const { command, args } = terminalCommand(
      agentKind,
      state?.agentSessionId ?? null,
    );
    return this.pty.create({
      runId: run.id,
      nodeId: wireNodeId,
      command,
      args,
      cwd,
      cols: input.cols,
      rows: input.rows,
    });
  }

  /**
   * A chat run carries its agent kind on the row and keys `node_state` under
   * the single-agent constant; a workflow run carries agent kinds per node in
   * its YAML definition, so the caller must name the node.
   */
  private async resolveNode(
    run: Run,
    nodeId: string | null,
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
