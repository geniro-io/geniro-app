import type {
  CalleePoolAttempt,
  CalleeTurnOutcome,
  WorkflowAgentNode,
  WorkflowAgentPoolMember,
} from '../graphs.types';

/**
 * An agent node's POOL — the configurations a call to it may run under.
 *
 * Member 1 is the node's own settings and members 2… are `node.pool`, so a
 * node with no pool is a pool of one and every reader below answers for it
 * without a special case.
 */

/** How many members `node` holds, its own configuration included. */
export function poolSize(node: WorkflowAgentNode): number {
  return 1 + (node.pool?.length ?? 0);
}

/** Every member's CLI settings, member 1 first. */
export function poolMembersOf(
  node: WorkflowAgentNode,
): WorkflowAgentPoolMember[] {
  return [memberSettingsOf(node), ...(node.pool ?? [])];
}

/**
 * The settings a member carries besides its `agent` that it REPLACES on the
 * node — omitted means that setting's own default, never member 1's value.
 * `MemberFieldsAreComplete` below makes a field added to the member schema and
 * missing from both lists a compile error: a member would otherwise silently
 * inherit member 1's value for it.
 */
const MEMBER_FIELDS = [
  'model',
  'effort',
  'contextWindow',
  'modelParameters',
  'configDir',
  'autoCompactPercent',
  // The servers a member runs WITHOUT name servers of ITS profile, so member
  // 1's list is never a member 2's: omitted means none switched off.
  'mcpDisabled',
] as const satisfies readonly Exclude<keyof WorkflowAgentPoolMember, 'agent'>[];

/**
 * The settings a member OVERRIDES when it states them and otherwise takes
 * from the node — those the node requires, so "omitted" has no default of its
 * own to fall back to.
 */
const INHERITED_FIELDS = ['approval'] as const satisfies readonly Exclude<
  keyof WorkflowAgentPoolMember,
  'agent'
>[];

type MissingMemberField = Exclude<
  Exclude<keyof WorkflowAgentPoolMember, 'agent'>,
  (typeof MEMBER_FIELDS)[number] | (typeof INHERITED_FIELDS)[number]
>;
type MemberFieldsAreComplete = [MissingMemberField] extends [never]
  ? true
  : MissingMemberField;
const _memberFieldsAreComplete: MemberFieldsAreComplete = true;
void _memberFieldsAreComplete;

function memberSettingsOf(node: WorkflowAgentNode): WorkflowAgentPoolMember {
  const settings: WorkflowAgentPoolMember = { agent: node.agent };
  for (const field of [...MEMBER_FIELDS, ...INHERITED_FIELDS]) {
    if (node[field] !== undefined) {
      Object.assign(settings, { [field]: node[field] });
    }
  }
  return settings;
}

/**
 * `node` running as member `member` (1-based), or null for a number the pool
 * does not have. The member's settings REPLACE the node's whole — an omitted
 * model is that CLI's default, never member 1's — except the INHERITED ones,
 * which the node's own value fills when the member states none. The view holds
 * no pool of its own, so nothing downstream can mistake it for the node.
 */
export function poolMemberNode(
  node: WorkflowAgentNode,
  member: number,
): WorkflowAgentNode | null {
  if (!Number.isInteger(member) || member < 1 || member > poolSize(node)) {
    return null;
  }
  const shared: WorkflowAgentNode = { ...node };
  delete shared.pool;
  for (const field of MEMBER_FIELDS) {
    delete shared[field];
  }
  const settings = poolMembersOf(node)[member - 1]!;
  return {
    ...shared,
    ...settings,
    approval: settings.approval ?? node.approval,
  };
}

/** The members to try, in `order`, resolved. */
export function poolAttempts(
  node: WorkflowAgentNode,
  order: readonly number[],
): CalleePoolAttempt[] {
  return order.flatMap((member) => {
    const resolved = poolMemberNode(node, member);
    return resolved ? [{ member, node: resolved }] : [];
  });
}

/**
 * The order a NEW conversation tries a pool's members in: round-robin from
 * `start`, with every member `isCooling` says is spent moved to the back —
 * still tried, in the same rotation, since a limit may have reset unseen.
 */
export function poolAttemptOrder(
  size: number,
  start: number,
  isCooling: (member: number) => boolean,
): number[] {
  const rotation = Array.from(
    { length: size },
    (_, i) => ((start - 1 + i) % size) + 1,
  );
  return [
    ...rotation.filter((member) => !isCooling(member)),
    ...rotation.filter((member) => isCooling(member)),
  ];
}

/**
 * Whether a failed attempt may be handed to the next member.
 *
 * Two kinds of failure qualify. One another ACCOUNT can get past — a spent
 * usage window, a lapsed sign-in — whatever the attempt had done, since the
 * caller asked for the work and this member can no longer do it. And any
 * failure before the attempt called a single tool: it changed nothing, so
 * running the call again elsewhere duplicates nothing. That second arm is
 * what covers a CLI whose limit wording no adapter recognises yet. A failure
 * mid-work is NOT handed on — running half-done work again from the top on
 * another member could repeat whatever it already did.
 */
export function fallsThroughPool(
  outcome: CalleeTurnOutcome,
  madeToolCalls: boolean,
): boolean {
  if (outcome.status !== 'failed') {
    return false;
  }
  return (
    outcome.failureClass === 'rate_limited' ||
    outcome.failureClass === 'auth_expired' ||
    !madeToolCalls
  );
}

/**
 * The transcript sentence for a call handed from one member to the next,
 * filed in the call's block so the reader sees why a different account
 * answered.
 */
export function poolHandOffNotice(
  calleeName: string,
  from: number,
  to: number,
  outcome: CalleeTurnOutcome,
): string {
  const why =
    outcome.failureClass === 'rate_limited'
      ? `hit a usage limit${outcome.resetsAt !== null ? ` (resets ${outcome.resetsAt})` : ''}`
      : outcome.failureClass === 'auth_expired'
        ? 'is signed out'
        : 'failed before doing any work';
  return `${calleeName}: pool member ${from} ${why} — handing the call to member ${to}.`;
}

/**
 * The task a handed-on call opens its next member with: the call's own
 * message, then everything said into the call while the failed attempt ran —
 * the next member starts a conversation of its own and heard none of it.
 */
export function poolHandOffPrompt(
  message: string,
  sentSince: readonly string[],
): string {
  if (sentSince.length === 0) {
    return message;
  }
  return [
    message,
    '',
    'Messages sent about this task after it was handed out, in order:',
    ...sentSince.map((text) => `- ${text}`),
  ].join('\n');
}

/**
 * One member as a caller is told it: its CLI, then whatever tells it apart —
 * model, effort, and whether it runs under a profile of its own (another
 * account). The profile is not NAMED: this line goes to the caller's model
 * provider, and the member number already tells two members apart.
 */
export function poolMemberLabel(member: WorkflowAgentPoolMember): string {
  return [
    member.agent,
    member.model,
    member.effort !== undefined ? `effort ${member.effort}` : undefined,
    member.configDir !== undefined ? 'separate profile' : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}
