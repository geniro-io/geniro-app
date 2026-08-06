import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { HandoffTarget } from '../handoff.types';
import { shellLine } from '../utils/shell-line';

/**
 * Resolves "let me carry this conversation on myself" into something the UI can
 * act on: the command that opens this run's own CLI session, or the reason
 * there isn't one.
 *
 * It RESOLVES and never RUNS. The daemon spawning a terminal emulator would be
 * a GUI action from a headless process; the Electron main process owns that,
 * and it is also what makes the answer copyable — the same string the user can
 * paste into a terminal of their own choosing.
 */
@Injectable()
export class HandoffService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly workflowStore: WorkflowStoreService,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /**
   * A refusal is a 200 carrying a reason, not an error status: "this CLI cannot
   * reopen its conversations" is the ANSWER to the question, and the button
   * renders it as a disabled control with the reason on hover. Only a
   * malformed request — an unknown run, a node that is not an agent — is a 4xx.
   */
  async resolve(input: {
    runId: string;
    nodeId?: string | null;
    sessionId?: string | null;
  }): Promise<HandoffTarget> {
    const em = this.em.fork();
    const run = await this.runDao.getById(input.runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${input.runId}`);
    }
    if (!run.workflowId && input.nodeId != null) {
      throw new BadRequestException(
        'HANDOFF_NODE_UNEXPECTED',
        `chat run ${run.id} does not accept a nodeId`,
      );
    }
    const nodeId = run.workflowId ? (input.nodeId ?? null) : null;
    const { agentKind, stateNodeId, model } = await this.resolveNode(
      run,
      nodeId,
      em,
    );
    const sessionId =
      input.sessionId ??
      (await this.nodeStateDao.getByRunNode(run.id, stateNodeId, em))
        ?.agentSessionId ??
      null;

    const target = this.adapters
      .for(agentKind)
      .handoffTarget({ sessionId, model });
    if (!target.ok) {
      return this.unavailable(
        target.reason === 'unsupported'
          ? this.reasonFor(agentKind)
          : 'this agent has not started a session yet — send a message first',
      );
    }
    if (!run.cwd) {
      return this.unavailable(
        `run ${run.id} has no working directory to open a terminal in`,
      );
    }
    const cwd = resolveValidCwd(run.cwd);
    return {
      kind: 'command',
      command: target.command,
      args: target.args,
      cwd,
      display: shellLine(target.command, target.args),
      unavailableReason: null,
    };
  }

  /**
   * How the user signs one CLI in to one MCP server, or why they cannot.
   *
   * Here rather than in `v1/agents` because the ANSWER is a handoff: both CLIs'
   * `mcp login` refuse a non-TTY stdin outright (probe-verified on claude
   * 2.1.223 — it exits non-zero ~1.6s in, before any OAuth callback could
   * arrive), so the daemon can never run one. What it can do is what this
   * module already does for a conversation: resolve the invocation and let the
   * user's own terminal be the TTY. Putting it in the MCP controller would have
   * meant a second copy of that resolution, quoting rule included.
   *
   * Takes no run: an MCP server belongs to a FOLDER, not to a conversation, and
   * the panel that offers this is reachable from a workflow node with no run of
   * its own.
   *
   * A refusal is a 200 carrying a reason, for the same reason {@link resolve}'s
   * is — "this CLI has no sign-in command" is the answer to the question.
   */
  mcpLoginTarget(input: {
    agent: AgentKind;
    cwd: string;
    server: string;
  }): HandoffTarget {
    const adapter = this.adapters.for(input.agent);
    const target = adapter.mcpLoginTarget(input.server);
    if (!target.ok) {
      return this.unavailable(
        adapter.getConfig().mcp.loginUnavailableReason ??
          `${input.agent} cannot sign in to an MCP server`,
      );
    }
    // Validated even though the CLI would reject a bad path itself: this string
    // is about to become the cwd of a process the USER's terminal spawns, and a
    // path that does not resolve here must fail as a bad request rather than as
    // a terminal window that opens and immediately dies.
    const cwd = resolveValidCwd(input.cwd);
    return {
      kind: 'command',
      command: target.command,
      args: target.args,
      cwd,
      display: shellLine(target.command, target.args),
      unavailableReason: null,
    };
  }

  /**
   * The CLI's OWN words for why it cannot, read from its adapter config — so a
   * new agent explains itself without this service learning its name.
   */
  private reasonFor(agentKind: AgentKind): string {
    const handoff = this.adapters.for(agentKind).getConfig().handoff;
    return handoff.kind === 'unavailable'
      ? handoff.reason
      : `${agentKind} cannot reopen this conversation`;
  }

  private unavailable(reason: string): HandoffTarget {
    return {
      kind: 'unavailable',
      command: null,
      args: [],
      cwd: null,
      display: null,
      unavailableReason: reason,
    };
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
    model: string | null;
  }> {
    if (!run.workflowId) {
      if (!run.agentKind) {
        throw new BadRequestException(
          'HANDOFF_NO_AGENT',
          `run ${run.id} has no agent kind`,
        );
      }
      return {
        agentKind: run.agentKind,
        stateNodeId: SINGLE_AGENT_NODE,
        model: run.model,
      };
    }
    if (!nodeId) {
      throw new BadRequestException(
        'HANDOFF_NODE_REQUIRED',
        `run ${run.id} is a workflow run — pass the nodeId to open`,
      );
    }
    const state = await this.nodeStateDao.getByRunNode(run.id, nodeId, em);
    const stamped = state?.agentKind;
    if (stamped) {
      // Both read from the STAMP, never from the current YAML: an edited
      // workflow must not re-write what a finished run actually ran as.
      return {
        agentKind: stamped,
        stateNodeId: nodeId,
        model: state?.model ?? null,
      };
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
      throw new BadRequestException(
        'HANDOFF_NODE_NOT_AGENT',
        `node ${nodeId} is a ${node.kind} node — only agent nodes have a session`,
      );
    }
    return {
      agentKind: node.agent,
      stateNodeId: nodeId,
      model: node.model ?? null,
    };
  }
}
