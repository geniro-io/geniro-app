import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import {
  CHAT_DEFAULT_APPROVAL,
  type ChatApprovalMode,
  MAX_ANSWER_LENGTH,
  type OwnedCardHost,
  SINGLE_AGENT_NODE,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { isAnalysisRun } from '../../agents/utils/analysed-runs';
import { readTeamDepartures } from '../../agents/utils/chat-team';
import { isCommandCenterChat } from '../../agents/utils/host-command-center';
import { isProjectChat } from '../../agents/utils/project-chat';
import { isChatTeamRun } from '../../agents/utils/run-kind';
import type { Run } from '../../runs/entity/run.entity';
import {
  type ApprovalMode,
  MAX_CHAT_TEAM_MEMBERS,
  type RunChangeProposal,
  type RunStartProposal,
  type RunTeamCardMember,
  type RunTeamChange,
  type RunTeamChangeRequest,
  type RunTeamMemberRequest,
  type RunTeamProposal,
  type RunTeamStartRequest,
  type Team,
  type TeamMember,
} from '../teams.types';
import { checkTeam } from '../utils/team-check';
import { diffTeams } from '../utils/team-diff';
import { runTeamHashOf } from '../utils/team-snapshot';
import { agentsThatRunAuto } from '../utils/unattended';
import { RunTeamService } from './run-team.service';
import type { PreparedProposal } from './team-proposal.service';
import { TeamExecutorService } from './team-executor.service';
import { TeamHealthService } from './team-health.service';

/** What a chat's lead is called on the team and on the card. */
const CHAT_LEAD_NAME = 'This chat';
const CHAT_LEAD_ROLE =
  'Leads the team: the chat the user talks to. It plans the work, hands each agent its task and brings the results together.';

/**
 * `run_team`: a chat's agent proposes a team on the fly, and the same chat
 * becomes that team when the user presses Start (a chat team, `teamId`
 * `chat:<runId>`); the lead of any running team changes it for that run only.
 * The card is `TeamProposalService`'s (one standing per run, rehydrated at
 * boot); this service decides what it shows and carries out its verdict. A
 * chat team is never written to the library (user decision).
 */
@Injectable()
export class ChatTeamService {
  private readonly logger = new Logger(ChatTeamService.name);

  /**
   * A start pressed with a note grants the lead's first team turn ONE change
   * without a card (user decision): only `add` or `update`, before any other
   * tool call of that turn. Keyed by run, holding the seq of the row that
   * opened that turn; in memory, so a restart only means the change gets a card.
   */
  private readonly remarkGrants = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly executor: TeamExecutorService,
    private readonly runTeams: RunTeamService,
    private readonly health: TeamHealthService,
  ) {}

  /** Which form of `run_team` a run takes, or why it takes none. */
  async formOf(
    runId: string,
  ): Promise<{ form: 'start' | 'change' } | { form: null; reason: string }> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      return { form: null, reason: 'the run is gone' };
    }
    if (run.teamId !== null) {
      return { form: 'change' };
    }
    return startableChatReason(run) === null
      ? { form: 'start' }
      : { form: null, reason: startableChatReason(run) as string };
  }

  /** Check a start form and build its card, or say why no card can be shown. */
  async prepareStart(
    runId: string,
    request: RunTeamStartRequest,
  ): Promise<PreparedProposal> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      return refused('RUN_GONE', 'the chat is gone');
    }
    const notChat = startableChatReason(run);
    if (notChat !== null) {
      return refused('NOT_STARTABLE_HERE', notChat);
    }
    if (request.team.members.length > MAX_CHAT_TEAM_MEMBERS) {
      return refused(
        'TOO_MANY_MEMBERS',
        `a team takes at most ${MAX_CHAT_TEAM_MEMBERS} agents beside this chat; this one names ${request.team.members.length}`,
      );
    }
    const approval = memberApprovalOf(run.approval);
    const lead = chatLeadOf(run);
    const members = request.team.members.map((member) =>
      memberOf(member, approval, run),
    );
    const team: Team = {
      name: request.team.name,
      mode: 'lead',
      members: [lead, ...members],
      triggers: [{ kind: 'first-message', member: SINGLE_AGENT_NODE }],
      instructionBlocks: [],
    };
    const unfit = await this.teamRefusal(team);
    if (unfit !== null) {
      return unfit;
    }
    const blockers = await this.chats.promotionBlockers(runId, null);
    if (blockers.length > 0) {
      return refused('NOT_STARTABLE_NOW', blockers.join('; '));
    }
    const tasks = new Map(
      request.team.members.map((member) => [member.id, member.task]),
    );
    const proposal: RunStartProposal = {
      mode: 'run-start',
      team,
      slug: '',
      summary: request.summary,
      reason: request.reason,
      autoAgents: agentsThatRunAuto(team),
      plan: request.plan,
      lead: cardMemberOf(lead),
      members: members.map((member) => ({
        member: cardMemberOf(member),
        task: tasks.get(member.id) ?? '',
      })),
    };
    return { ok: true, proposal };
  }

  /** Check a change form against the run's team as it stands and build its card. */
  async prepareChange(
    runId: string,
    request: RunTeamChangeRequest,
  ): Promise<PreparedProposal> {
    const planned = await this.planChange(runId, request);
    if (!planned.ok) {
      return planned;
    }
    return { ok: true, proposal: planned.proposal };
  }

  private async planChange(
    runId: string,
    request: RunTeamChangeRequest,
  ): Promise<
    | { ok: true; proposal: RunChangeProposal; removed: string[] }
    | { ok: false; code: string; message: string }
  > {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null || run.teamId === null) {
      return refused('NOT_A_TEAM_RUN', 'only a running team can be changed');
    }
    const current = await this.runTeams.teamOf(run as Run & { teamId: string }, em);
    const departed = new Set(
      readTeamDepartures(run.teamDeparted).map((left) => left.memberId),
    );
    const lead = run.currentLead;
    const approval =
      current.members.find((member) => member.id === lead)?.approval ??
      memberApprovalOf(null);
    const members = current.members.map((member) => ({ ...member }));
    const changes: RunTeamChange[] = [];
    const removed: string[] = [];
    const known = (id: string): TeamMember | undefined =>
      members.find((member) => member.id === id);
    for (const edit of request.edits) {
      if (edit.op === 'add') {
        if (known(edit.member.id) !== undefined) {
          return refused(
            'MEMBER_EXISTS',
            `the team already has (or had) an agent with id '${edit.member.id}'`,
          );
        }
        const member = memberOf(edit.member, approval, run);
        members.push(member);
        changes.push({
          op: 'add',
          member: cardMemberOf(member),
          task: edit.member.task,
        });
        continue;
      }
      const target = known(edit.memberId);
      if (target === undefined || departed.has(edit.memberId)) {
        return refused(
          'UNKNOWN_MEMBER',
          `the team has no agent with id '${edit.memberId}'`,
        );
      }
      if (edit.op === 'remove') {
        if (edit.memberId === lead) {
          return refused(
            'LEAD_STAYS',
            'the agent leading the team cannot be removed from it',
          );
        }
        removed.push(edit.memberId);
        changes.push({ op: 'remove', memberId: target.id, name: target.name });
        continue;
      }
      const fields: Extract<RunTeamChange, { op: 'update' }>['fields'] = [];
      for (const field of ['role', 'instructions', 'model', 'effort'] as const) {
        const after = edit[field];
        if (after === undefined || after === (target[field] ?? null)) {
          continue;
        }
        fields.push({ field, before: target[field] ?? null, after });
        target[field] = after;
      }
      if (fields.length === 0 && edit.task === undefined) {
        return refused(
          'NOTHING_TO_CHANGE',
          `the change to '${target.id}' changes nothing`,
        );
      }
      changes.push({
        op: 'update',
        memberId: target.id,
        name: target.name,
        fields,
        task: edit.task ?? null,
      });
    }
    if (changes.length === 0) {
      return refused('NOTHING_TO_CHANGE', 'the change names no edit');
    }
    const next: Team = { ...current, members };
    const nowDeparted = new Set([...departed, ...removed]);
    const addedHere = members.filter(
      (member) => member.id !== lead && !nowDeparted.has(member.id),
    ).length;
    if (isChatTeamRun(run) && addedHere > MAX_CHAT_TEAM_MEMBERS) {
      return refused(
        'TOO_MANY_MEMBERS',
        `a team takes at most ${MAX_CHAT_TEAM_MEMBERS} agents beside its lead; this change makes ${addedHere}`,
      );
    }
    const unfit = await this.teamRefusal(next);
    if (unfit !== null) {
      return unfit;
    }
    return {
      ok: true,
      removed,
      proposal: {
        mode: 'run-change',
        team: next,
        slug: run.teamId,
        summary: request.summary,
        reason: request.reason,
        autoAgents: agentsThatRunAuto(next),
        baseHash: runTeamHashOf(run.teamSnapshot),
        changes,
        diff: diffTeams(current, next),
      },
    };
  }

  /** Why a team cannot run as built, or null: its shape, its models, its CLIs. */
  private async teamRefusal(
    team: Team,
  ): Promise<{ ok: false; code: string; message: string } | null> {
    const checked = checkTeam(team);
    if (!checked.ok) {
      return refused(checked.code, checked.message);
    }
    const missing = await this.health.missingClis(team);
    if (missing.length > 0) {
      return refused(
        'CLI_NOT_INSTALLED',
        `not installed on this Mac: ${missing.join(', ')} — pick an installed CLI`,
      );
    }
    try {
      await this.executor.assertRunnable(team);
    } catch (error) {
      return refused(
        'NOT_RUNNABLE',
        error instanceof Error ? error.message : 'the team cannot run',
      );
    }
    return null;
  }

  /**
   * The remark change (user decision): the lead's first team turn after a
   * start pressed with a note may apply ONE `add` or `update` without a card,
   * before any other tool call of that turn. Answers the applied change's
   * receipt, or null when no grant covers this call — then it goes on a card.
   */
  async applyRemarkChange(
    runId: string,
    request: RunTeamChangeRequest,
  ): Promise<string | null> {
    const openedAt = this.remarkGrants.get(runId);
    if (openedAt === undefined) {
      return null;
    }
    this.remarkGrants.delete(runId);
    if (
      request.edits.length !== 1 ||
      request.edits[0]?.op === 'remove' ||
      !(await this.firstToolCallOfTurn(runId, openedAt))
    ) {
      return null;
    }
    const planned = await this.planChange(runId, request);
    if (!planned.ok) {
      return `Not applied — ${planned.code}: ${planned.message}. No card was shown.`;
    }
    await this.executor.writeRunNote(runId, {
      severity: 'info',
      message: `Changed per the user's note: ${changeLines(planned.proposal.changes).join('; ')}`,
      chatTeam: { phase: 'changed', remark: true, changes: planned.proposal.changes },
    });
    const applied = await this.executor.changeRunTeam(
      runId,
      planned.proposal.team,
      planned.proposal.baseHash,
      planned.removed,
    );
    if (applied.status === 'refused') {
      return `Not applied — ${applied.reason}. No card was shown.`;
    }
    return `Applied per the user's note, with no card: ${changeLines(planned.proposal.changes).join('; ')}. ${rosterText(applied.team, applied.departed, planned.removed)}`;
  }

  /** Whether the lead has made no tool call but `run_team` since its turn opened, and that turn still runs. */
  private async firstToolCallOfTurn(
    runId: string,
    openedAt: number,
  ): Promise<boolean> {
    const rows = await this.itemDao.rowsOfKindsBetween(
      runId,
      ['tool_call', 'turn_complete', 'turn_cancelled', 'error'],
      openedAt,
      Number.MAX_SAFE_INTEGER,
      this.em.fork(),
    );
    const own = rows.filter(
      (row) => row.memberId === SINGLE_AGENT_NODE && (row.inCall ?? '') === '',
    );
    if (own.some((row) => row.kind !== 'tool_call')) {
      return false;
    }
    return own.every((row) => (row.toolNameLower ?? '').endsWith('run_team'));
  }

  /**
   * The user pressed a `run_team` card. A start becomes the team once no turn
   * of the chat runs; a change is written to the run's team at once. Either
   * way the verdict row carries what happened, and the agent hears it as its
   * next message (a start's as the team's first turn).
   */
  async carryOutVerdict(
    runId: string,
    requestId: string,
    proposal: RunTeamProposal,
    allow: boolean,
    answer: string | undefined,
    cards: OwnedCardHost,
  ): Promise<void> {
    const note = (answer ?? '').trim().slice(0, MAX_ANSWER_LENGTH);
    const noted = note === '' ? '' : ` The user's note: ${note}`;
    if (proposal.mode === 'run-start') {
      if (!allow) {
        await cards.deliverOwnedCardVerdict(
          runId,
          requestId,
          false,
          `(Declined — no team was started.${noted})`,
          answer,
        );
        return;
      }
      this.chats.whenTurnEnds(runId, () =>
        this.start(runId, requestId, proposal, note, answer, cards),
      );
      return;
    }
    if (!allow) {
      await cards.deliverOwnedCardVerdict(
        runId,
        requestId,
        false,
        `(Declined — the team stays as it is.${noted})`,
        answer,
      );
      return;
    }
    const removed = proposal.changes.flatMap((change) =>
      change.op === 'remove' ? [change.memberId] : [],
    );
    const applied = await this.executor.changeRunTeam(
      runId,
      proposal.team,
      proposal.baseHash,
      removed,
    );
    if (applied.status === 'refused') {
      await cards.deliverOwnedCardVerdict(
        runId,
        requestId,
        true,
        `(Not applied — ${applied.reason}. Propose the change again with run_team.${noted})`,
        answer,
        { kind: 'not-changed', reason: applied.reason },
      );
      return;
    }
    const tasks = proposal.changes.flatMap((change) =>
      change.op !== 'remove' && change.task !== null
        ? [`${change.op === 'add' ? change.member.name : change.name}: ${change.task}`]
        : [],
    );
    await cards.deliverOwnedCardVerdict(
      runId,
      requestId,
      true,
      `(Applied — ${rosterText(applied.team, applied.departed, removed)}${
        applied.reaches === 'next-pass'
          ? ' The agents added can be called from your next turn.'
          : ''
      }${
        tasks.length === 0
          ? ''
          : ` Hand each its task: ${tasks.join('; ')}.`
      }${noted})`,
      answer,
      { kind: 'changed' },
    );
  }

  /** Promote the chat, once no turn of it runs. */
  private async start(
    runId: string,
    requestId: string,
    proposal: RunStartProposal,
    note: string,
    answer: string | undefined,
    cards: OwnedCardHost,
  ): Promise<void> {
    const causes = await this.chats.promotionBlockers(runId, requestId);
    const unfit = causes.length > 0 ? null : await this.teamRefusal(proposal.team);
    if (unfit !== null) {
      causes.push(unfit.message);
    }
    const noted = note === '' ? '' : ` The user's note: ${note}`;
    if (causes.length > 0) {
      await cards.deliverOwnedCardVerdict(
        runId,
        requestId,
        true,
        `(Not started — ${causes.join('; ')}. Close what is named, then propose the team again with run_team.${noted})`,
        answer,
        { kind: 'not-started', causes },
      );
      return;
    }
    await this.chats.recordOwnedCardVerdict(runId, requestId, true, {
      ...(answer === undefined ? {} : { answer }),
      outcome: { kind: 'started' },
    });
    this.chats.releaseForTeam(runId);
    let opened: number;
    try {
      opened = await this.executor.promoteChat(
        runId,
        proposal.team,
        startPrompt(proposal, note),
        `This chat is now a team: ${proposal.members
          .map((entry) => entry.member.name)
          .join(', ')} joined it.`,
      );
    } catch (error) {
      this.logger.error(
        `run ${runId} could not become a team: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (note !== '') {
      this.remarkGrants.set(runId, opened);
    }
  }
}

/** Why this run's agent may not start a team from it, or null when it may. */
function startableChatReason(run: Run): string | null {
  if (run.teamId !== null) {
    return 'this chat already runs a team';
  }
  if (isAnalysisRun(run)) {
    return 'an analysis cannot become a team';
  }
  if (run.editsTeamSlug !== null) {
    return "a team's builder chat cannot become a team";
  }
  if (isProjectChat(run)) {
    return "a project's own chat cannot become a team";
  }
  if (isCommandCenterChat(run)) {
    return 'the command center cannot become a team';
  }
  return null;
}

/** A chat's approval mode as a member's (user decision: new agents ask as the chat does). */
function memberApprovalOf(mode: ChatApprovalMode | null): ApprovalMode {
  const chat = mode ?? CHAT_DEFAULT_APPROVAL;
  return chat === 'plan' ? 'ask' : chat;
}

/** The chat's own agent as the team's lead: its id is the chat's own conversation's. */
function chatLeadOf(run: Run): TeamMember {
  return {
    id: SINGLE_AGENT_NODE,
    name: CHAT_LEAD_NAME,
    role: CHAT_LEAD_ROLE,
    agent: run.agentKind ?? 'claude',
    ...(run.model === null ? {} : { model: run.model }),
    ...(run.effort === null ? {} : { effort: run.effort }),
    ...(run.configDir === null ? {} : { configDir: run.configDir }),
    approval: memberApprovalOf(run.approval),
  };
}

function memberOf(
  request: RunTeamMemberRequest,
  approval: ApprovalMode,
  run: Run,
): TeamMember {
  return {
    id: request.id,
    name: request.name,
    role: request.role,
    instructions: request.instructions,
    agent: request.agent,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(run.configDir !== null && request.agent === run.agentKind
      ? { configDir: run.configDir }
      : {}),
    approval,
  };
}

function cardMemberOf(member: TeamMember): RunTeamCardMember {
  return {
    memberId: member.id,
    name: member.name,
    role: member.role ?? '',
    agent: member.agent,
    model: member.model ?? null,
    approval: member.approval,
  };
}

function refused(
  code: string,
  message: string,
): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/** The lead's first team turn: the plan, the agents and their tasks, the note. */
function startPrompt(proposal: RunStartProposal, note: string): string {
  const plan = proposal.plan.map((line, at) => `${at + 1}. ${line}`);
  const agents = proposal.members.map(
    ({ member, task }) =>
      `- ${member.name} (id ${member.memberId}, ${member.agent}${member.model === null ? '' : ` · ${member.model}`}): ${member.role} Task: ${task}`,
  );
  return [
    '(The user pressed Start: this chat is now a team, and you lead it. Hand each agent its task with call_agent, then bring the results together.',
    '',
    'The plan:',
    ...plan,
    '',
    'The agents who joined:',
    ...agents,
    ...(note === ''
      ? []
      : [
          '',
          `The user's note: ${note}`,
          'Apply it first. If it asks to add an agent or change one, call run_team with that ONE change before any other tool: it applies without a card. Anything else — removing an agent, or more than one change — goes on a card as usual.',
        ]),
    ')',
  ].join('\n');
}

function changeLines(changes: readonly RunTeamChange[]): string[] {
  return changes.map((change) => {
    switch (change.op) {
      case 'add':
        return `+ ${change.member.name} joins`;
      case 'remove':
        return `− ${change.name} finishes its current call, then leaves`;
      case 'update':
        return `~ ${change.name}: ${change.fields.map((field) => field.field).join(', ') || 'new task'}`;
    }
  });
}

/** The team as it stands after a change, for the lead: who left before is left out. */
function rosterText(
  team: Team,
  departed: readonly string[],
  leaving: readonly string[],
): string {
  const left = new Set(leaving);
  const gone = new Set(departed.filter((id) => !left.has(id)));
  const lines = team.members
    .filter((member) => !gone.has(member.id))
    .map(
      (member) =>
        `${member.name} (id ${member.id})${left.has(member.id) ? ' — finishes its current call, then leaves' : ''}`,
    );
  return `The team now: ${lines.join('; ')}.`;
}
