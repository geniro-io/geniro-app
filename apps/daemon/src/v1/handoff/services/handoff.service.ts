import { homedir } from 'node:os';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import type { HandoffResult } from '../../agents/adapters/adapter.types';
import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { resolveValidConfigDir } from '../../agents/utils/resolve-config-dir';
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
    const { agentKind, stateNodeId, model, configDir } = await this.resolveNode(
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
      .handoffTarget({ sessionId, model, configDir });
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
    return this.command(target, cwd);
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
    configDir?: string;
  }): HandoffTarget {
    const adapter = this.adapters.for(input.agent);
    const target = adapter.mcpLoginTarget(
      input.server,
      input.configDir === undefined
        ? null
        : resolveValidConfigDir(input.configDir),
    );
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
    return this.command(target, cwd);
  }

  /**
   * How the user signs the CLI ITSELF in, or why they cannot.
   *
   * The sibling of {@link mcpLoginTarget} one level up, and reached by a
   * different failure: that one fixes a server the CLI could not authenticate,
   * this one fixes the CLI's own expired account session — the turn that ends
   * "Failed to authenticate: OAuth session expired and could not be refreshed".
   * Offering the MCP one there would send the user to a command that cannot fix
   * what they hit.
   *
   * Here for the same reason its sibling is: the answer is a handoff. A sign-in
   * is an interactive browser flow wanting a TTY, so the daemon resolves the
   * invocation and the user's own terminal runs it.
   *
   * Takes no run — an account is machine-wide, and the screen that offers this
   * may have no run open at all.
   */
  loginTarget(input: {
    agent: AgentKind;
    cwd?: string;
    configDir?: string;
  }): HandoffTarget {
    const adapter = this.adapters.for(input.agent);
    const target = adapter.loginTarget(
      input.configDir === undefined
        ? null
        : resolveValidConfigDir(input.configDir),
    );
    if (!target.ok) {
      return this.unavailable(
        adapter.getConfig().auth.loginUnavailableReason ??
          `${input.agent} has no sign-in command`,
      );
    }
    // Validated when given, for the reason the MCP sibling validates its own:
    // this becomes the cwd of a process the USER's terminal spawns, and a path
    // that does not resolve must fail as a bad request rather than as a window
    // that opens and immediately dies.
    //
    // Falls back to the home directory rather than to null, even though a
    // sign-in genuinely does not care where it runs: the Electron side takes a
    // validated ABSOLUTE path and writes `cd <cwd> || exit 1` into the script
    // it opens, so "nowhere in particular" has no representation there. Home is
    // the one folder that always exists and can surprise nobody.
    const cwd =
      input.cwd === undefined ? homedir() : resolveValidCwd(input.cwd);
    return this.command(target, cwd);
  }

  /**
   * The CLI's OWN words for why it cannot, asked of its adapter — so a new
   * agent explains itself without this service learning its name.
   *
   * Delegated rather than reading `getConfig().handoff` here, because
   * `CapabilitiesService` needs the same answer for a CLI with no run in sight
   * and previously invented its own sentence instead. One reader of the config
   * field, two consumers of the reason.
   *
   * The fallback is unreachable by construction — this is only called on an
   * `unsupported` refusal, which the adapter returns only for an `unavailable`
   * handoff config — and stays as the total answer the signature promises.
   */
  private reasonFor(agentKind: AgentKind): string {
    return (
      this.adapters.for(agentKind).handoffUnavailableReason() ??
      `${agentKind} cannot reopen this conversation`
    );
  }

  /**
   * The success half of the wire shape, once — the mirror of
   * {@link unavailable}.
   *
   * Both halves of one contract, maintained the same way: the refusal was
   * already a helper while the success was copy-pasted at each of the three
   * resolve methods, which is how the `display` line (the pasteable fallback a
   * terminal geniro cannot launch depends on) could go missing from one of them
   * without anything noticing.
   */
  private command(
    target: Extract<HandoffResult, { ok: true }>,
    cwd: string,
  ): HandoffTarget {
    return {
      kind: 'command',
      command: target.command,
      args: target.args,
      cwd,
      env: target.env,
      // The env is part of the line, not a footnote to it: `CLAUDE_CONFIG_DIR=…
      // claude --resume …` is what a user has to paste for the command to mean
      // what the button means.
      display: shellLine(target.command, target.args, target.env),
      unavailableReason: null,
    };
  }

  private unavailable(reason: string): HandoffTarget {
    return {
      kind: 'unavailable',
      command: null,
      args: [],
      cwd: null,
      env: {},
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
    /**
     * Null for every WORKFLOW node, and deliberately: `node_state` stamps no
     * config directory, so run history cannot say which one a finished node
     * ran under, and reading today's YAML would claim one the run may never
     * have seen — the same reason its agent kind and model are read from the
     * stamp. A chat's directory IS on its own row, so a chat can be handed
     * back exactly as it ran.
     */
    configDir: string | null;
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
        configDir: run.configDir,
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
        configDir: null,
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
      configDir: null,
    };
  }
}
