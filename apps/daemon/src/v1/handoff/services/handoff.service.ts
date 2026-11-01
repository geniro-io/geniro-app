import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import type { HandoffResult } from '../../agents/adapters/adapter.types';
import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { RunKindRowsCache } from '../../agents/services/run-kind-rows.cache';
import {
  CALL_RECORDS,
  readCallSeed,
  sessionMember,
} from '../../agents/utils/call-seed';
import {
  nodePoolSessionMember,
  readNodePoolMembers,
} from '../../agents/utils/node-pool-members';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { assertTeamRun } from '../../agents/utils/run-kind';
import {
  callSessionKeyPrefix,
  nodeSessionKey,
} from '../../agents/utils/session-keys';
import {
  snapshotMemberProfile,
  snapshotNodePoolProfiles,
} from '../../agents/utils/snapshot-config-dirs';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import { RunTeamService } from '../../teams/services/run-team.service';
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
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly runTeams: RunTeamService,
    private readonly adapters: AgentAdapterRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly kindRows: RunKindRowsCache,
  ) {}

  /**
   * A refusal is a 200 carrying a reason, not an error status: "this CLI cannot
   * reopen its conversations" is the ANSWER to the question, and the button
   * renders it as a disabled control with the reason on hover. Only a
   * malformed request — an unknown run or member — is a 4xx.
   */
  async resolve(input: {
    runId: string;
    memberId?: string | null;
    sessionId?: string | null;
  }): Promise<HandoffTarget> {
    const em = this.em.fork();
    const run = await this.runDao.getById(input.runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${input.runId}`);
    }
    if (!run.teamId && input.memberId != null) {
      throw new BadRequestException(
        'HANDOFF_NODE_UNEXPECTED',
        `chat run ${run.id} does not accept a memberId`,
      );
    }
    const memberId = run.teamId ? (input.memberId ?? null) : null;
    const own = await this.resolveNode(run, memberId, em);
    const { agentKind, stateNodeId, model, configDir } =
      memberId !== null && input.sessionId
        ? ((await this.poolMemberOf(run, memberId, input.sessionId, em)) ?? own)
        : own;
    const sessionId =
      input.sessionId ??
      (await this.nodeStateDao.getByRunNode(run.id, stateNodeId, em))
        ?.agentSessionId ??
      null;

    const adapter = this.adapters.for(agentKind);
    let target: HandoffResult;
    try {
      await adapter.validateModel(model);
      target = adapter.handoffTarget({
        sessionId,
        model,
        configDir,
        held: this.mayHold(run, memberId),
      });
    } catch (error) {
      return this.unavailable(
        error instanceof Error ? error.message : String(error),
      );
    }
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
   * Whether geniro's own kept process may still hold the conversation being
   * handed over — which a CLI allowing one process per conversation needs to
   * know (`handoff.heldFlag`). A chat's process is keyed exactly. A team
   * member's conversation may sit in its own process or in a CALL's, and a
   * call's is keyed by its conversation's first call, which this request does
   * not name — so any live call process of the run counts too. Reading a
   * conversation nobody holds as held costs only a copy where a resume would
   * do; the reverse hands over a command that fails.
   */
  private mayHold(run: Run, memberId: string | null): boolean {
    if (!run.teamId) {
      return this.sessions.peek(run.id) !== null;
    }
    return (
      (memberId !== null &&
        this.sessions.peek(nodeSessionKey(run.id, memberId)) !== null) ||
      this.sessions.holdsAnyUnder(callSessionKeyPrefix(run.id))
    );
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
   * already a helper while the success was copy-pasted at each resolve method
   * back when there were three, which is how the `display` line (the pasteable
   * fallback a terminal geniro cannot launch depends on) could go missing from
   * one of them without anything noticing. One is left — signing a CLI in or
   * out is run by the daemon now, not handed to a shell (`v1/auth`) — and the
   * split stays because the shape is the contract, not the number of callers.
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
   * The pool member a call thread's session ran on, when its member has a pool:
   * the member's `node_state` stamp is member 1's, and resuming a session under
   * another member's CLI or profile finds no such conversation.
   */
  private async poolMemberOf(
    run: Run,
    memberId: string,
    sessionId: string,
    em: EntityManager,
  ): Promise<{
    agentKind: AgentKind;
    stateNodeId: string;
    model: string | null;
    configDir: string | null;
  } | null> {
    let member = sessionMember(
      readCallSeed(
        await this.kindRows.rowsOfView(run.id, CALL_RECORDS, 'fresh'),
      ).records,
      sessionId,
    );
    if (
      member === null &&
      snapshotNodePoolProfiles(run.teamSnapshot).has(memberId)
    ) {
      member = nodePoolSessionMember(
        await this.itemDao.rowsOfKinds(
          run.id,
          ['system', 'turn_complete'],
          undefined,
          em,
        ),
        memberId,
        sessionId,
      );
    }
    const profile =
      member === null
        ? null
        : snapshotMemberProfile(run.teamSnapshot, memberId, member);
    return profile === null ? null : { ...profile, stateNodeId: memberId };
  }

  /**
   * A chat run carries its agent kind on the row and keys `node_state` under
   * the single-agent constant; a team member's agent kind comes from the
   * `agent_kind` stamped on its `node_state` row at turn start — run history,
   * immune to later team-YAML edits. Only a row not stamped yet (a member
   * that never started a turn) falls back to the CURRENT YAML definition.
   */
  private async resolveNode(
    run: Run,
    memberId: string | null,
    em: EntityManager,
  ): Promise<{
    agentKind: AgentKind;
    stateNodeId: string;
    model: string | null;
    /**
     * A pooled own conversation's directory comes from its member record and
     * the run's immutable snapshot. Other team members carry null: their
     * state stamps no directory, and today's YAML cannot identify
     * a historical account. Chats carry their directory on the run itself.
     */
    configDir: string | null;
  }> {
    if (!run.teamId) {
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
    if (!memberId) {
      throw new BadRequestException(
        'HANDOFF_NODE_REQUIRED',
        `run ${run.id} is a team run — pass the memberId to open`,
      );
    }
    const state = await this.nodeStateDao.getByRunNode(run.id, memberId, em);
    const stamped = state?.agentKind;
    if (stamped) {
      let configDir: string | null = null;
      if (snapshotNodePoolProfiles(run.teamSnapshot).has(memberId)) {
        const member =
          readNodePoolMembers(
            await this.itemDao.poolHandOffRows(run.id, em),
          ).get(memberId) ?? 1;
        const profile = snapshotMemberProfile(
          run.teamSnapshot,
          memberId,
          member,
        );
        if (
          profile?.agentKind === stamped &&
          profile.model === (state.model ?? null)
        ) {
          configDir = profile.configDir;
        }
      }
      // Both read from the STAMP, never from the current YAML: an edited
      // team must not re-write what a finished run actually ran as.
      return {
        agentKind: stamped,
        stateNodeId: memberId,
        model: state?.model ?? null,
        configDir,
      };
    }
    // The run's OWN copy of the team, never the library's current one — an
    // edited team must not re-write what this run's member is.
    const team = await this.runTeams.teamOf(assertTeamRun(run, run.id), em);
    const teamMember = team.members.find((member) => member.id === memberId);
    if (!teamMember) {
      throw new NotFoundException(
        'NODE_NOT_FOUND',
        `team ${run.teamId} has no member: ${memberId}`,
      );
    }
    return {
      agentKind: teamMember.agent,
      stateNodeId: memberId,
      model: teamMember.model ?? null,
      configDir: null,
    };
  }
}
