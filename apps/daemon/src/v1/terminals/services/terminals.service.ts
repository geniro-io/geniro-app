import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import type { TerminalCommandResult } from '../../agents/adapters/adapter.types';
import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { TurnMirrorService } from '../../agents/services/turn-mirror.service';
import { claudeCredentialEnv } from '../../agents/utils/child-env';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { TerminalKind, TerminalSessionWire } from '../terminals.types';
import { TerminalSessionsService } from './terminal-sessions.service';

/**
 * Resolves "open a terminal for this run/node" into a concrete session, of
 * whichever kind was asked for.
 *
 * For an INTERACTIVE one that means a PTY spawn: the run supplies the cwd, the
 * node (workflow YAML for graph runs, the run row itself for chats) supplies
 * the agent kind, and the CLI session id comes from `node_state` (the node's
 * latest session) — or, when the caller passes an explicit `sessionId`, from a
 * specific thread of the node (a call thread's resume id recorded on its
 * `call_result` item), so every thread of an agent can be mirrored, not just
 * the most recent one.
 *
 * For a LIVE one it means almost nothing: the turn's own output is already
 * buffered by `TurnMirrorService`, so this only validates the node and hands
 * that buffer over.
 */
@Injectable()
export class TerminalsService implements OnApplicationShutdown {
  private readonly logger = new Logger(TerminalsService.name);
  /**
   * In-flight creates keyed by the mirror target — `runId:nodeId:sessionId`
   * (the RESOLVED session). The daemon owns the one-running-mirror-per-target
   * invariant: without this single-flight, two concurrent POSTs (a
   * double-click) both miss {@link TerminalSessionsService.findRunning} during their awaits
   * and spawn two `claude --resume <same session>` REPLs — the second
   * invisible to the UI until daemon shutdown.
   */
  private readonly pending = new Map<string, Promise<TerminalSessionWire>>();
  /** Unsubscribes the run-deleted listener when the daemon shuts down. */
  private readonly deletedSubscription: Subscription;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly workflowStore: WorkflowStoreService,
    private readonly sessions: TerminalSessionsService,
    private readonly adapters: AgentAdapterRegistry,
    private readonly mirrors: TurnMirrorService,
    bus: AgentEventBus,
  ) {
    // A mirror of a deleted run would keep a `claude --resume` child alive
    // against a transcript that no longer exists. Subscribed HERE rather than
    // called from the deleting service, because `TerminalsModule` imports
    // `AgentsModule` — the dependency only runs this way.
    this.deletedSubscription = bus.allDeleted().subscribe((runId) => {
      const killed = this.sessions.killRun(runId);
      if (killed > 0) {
        this.logger.log(
          `killed ${killed} terminal mirror(s) of deleted run ${runId}`,
        );
      }
    });
  }

  onApplicationShutdown(): void {
    this.deletedSubscription.unsubscribe();
  }

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
    kind?: TerminalKind | null;
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
    if ((input.kind ?? 'live') === 'live') {
      // Most of what follows does not apply to a live mirror: it spawns no CLI,
      // so it needs no agent kind, no resumable session, no model and no cwd —
      // which is why it is available for agents whose adapters refuse an
      // interactive mirror outright (cursor-agent's `terminal: null`).
      //
      // Node IDENTITY is the exception, and is validated by the same
      // `resolveNode` the interactive path uses. Opening a mirror CREATES its
      // buffer, and buffers evict least-recently-touched, so accepting any
      // string as a node id would let a caller evict a run's real turn history
      // by opening mirrors on nodes that do not exist.
      if (run.workflowId) {
        await this.resolveNode(run, nodeId, em);
      }
      return this.createLiveMirror(run, nodeId);
    }
    const { agentKind, stateNodeId, wireNodeId, model } =
      await this.resolveNode(run, nodeId, em);
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
      { ...input, nodeId: wireNodeId, agentKind, resumeSessionId, model },
      run,
    ).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, create);
    return create;
  }

  /**
   * Open (or re-attach to) the live mirror of one node's own turns.
   *
   * Synchronous end to end — every await (the run lookup, the node validation)
   * happens in the caller before this runs, which is what keeps it single-flight
   * without the `pending` map the interactive path needs: two concurrent POSTs
   * cannot interleave between {@link TerminalSessionsService.findRunning} and
   * {@link TerminalSessionsService.createMirror}.
   */
  private createLiveMirror(
    run: Run,
    nodeId: string | null,
  ): TerminalSessionWire {
    const existing = this.sessions.findRunning('live', run.id, nodeId);
    if (existing) {
      return existing;
    }
    // The key the TURN side writes under: a chat's per-node state all lives
    // under the single-agent constant, and the wire's `nodeId` is null there.
    const mirrorNode = nodeId ?? SINGLE_AGENT_NODE;
    return this.sessions.createMirror({
      runId: run.id,
      nodeId,
      // Informational only — a live mirror runs nothing, so a run with no
      // folder still gets one (unlike the interactive `--resume` spawn).
      cwd: run.cwd ?? '',
      // Read and subscribed in one synchronous tick, per the attach contract.
      snapshot: this.mirrors.snapshot(run.id, mirrorNode),
      source: this.mirrors.stream(run.id, mirrorNode),
    });
  }

  private async doCreateForRun(
    input: {
      runId: string;
      nodeId: string | null;
      agentKind: AgentKind;
      resumeSessionId: string | null;
      /** The model this thread chats as — the mirror opens on the same one. */
      model: string | null;
      cols?: number;
      rows?: number;
    },
    run: Run,
  ): Promise<TerminalSessionWire> {
    const existing = this.sessions.findRunning(
      'interactive',
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
    // The thread's own model rides along: a mirror that opened on the CLI's
    // default was a different model with a different context window sitting
    // beside the chat it was supposed to be mirroring.
    const { command, args } = this.resolveInvocation(
      input.agentKind,
      input.resumeSessionId,
      input.model,
    );
    return this.sessions.create({
      runId: run.id,
      nodeId: input.nodeId,
      resumeSessionId: input.resumeSessionId,
      command,
      args,
      cwd,
      cols: input.cols,
      rows: input.rows,
      // Terminal mirrors are claude-only in v1 (every other CLI's adapter
      // answers `unsupported`), so every session gets the claude-child
      // credential re-injection buildChildEnv otherwise strips.
      env: claudeCredentialEnv(),
    });
  }

  /**
   * Ask the agent's OWN adapter for the mirror invocation and turn its refusal
   * into the HTTP answer this module owes the caller.
   *
   * The two refusals are genuinely different outcomes and keep their distinct
   * codes: `unsupported` is permanent for that CLI (no retry will help),
   * `no-session` is a not-YET (the node has produced no resumable session).
   * The adapter returns them as data rather than throwing, so nothing in the
   * adapter layer has to know about HTTP — and nothing here has to know which
   * CLI it is talking to.
   */
  private resolveInvocation(
    agentKind: AgentKind,
    resumeSessionId: string | null,
    model: string | null,
  ): Extract<TerminalCommandResult, { ok: true }> {
    const resolved = this.adapters
      .for(agentKind)
      .terminalCommand({ sessionId: resumeSessionId, model });
    if (resolved.ok) {
      return resolved;
    }
    if (resolved.reason === 'unsupported') {
      throw new BadRequestException(
        'TERMINAL_UNSUPPORTED',
        `no interactive terminal support for agent kind: ${agentKind}`,
      );
    }
    throw new BadRequestException(
      'TERMINAL_SESSION_UNAVAILABLE',
      'the agent has not produced a resumable terminal session yet',
    );
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
    model: string | null;
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
        model: run.model,
      };
    }
    if (!nodeId) {
      throw new BadRequestException(
        'TERMINAL_NODE_REQUIRED',
        `run ${run.id} is a workflow run — pass the nodeId to mirror`,
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
        wireNodeId: nodeId,
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
      // Only agent nodes run a CLI session there is anything to mirror of.
      throw new BadRequestException(
        'TERMINAL_NODE_NOT_AGENT',
        `node ${nodeId} is a ${node.kind} node — only agent nodes have a terminal`,
      );
    }
    return {
      agentKind: node.agent,
      stateNodeId: nodeId,
      wireNodeId: nodeId,
      model: node.model ?? null,
    };
  }
}
