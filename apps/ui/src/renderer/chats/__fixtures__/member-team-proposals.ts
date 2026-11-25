/**
 * `propose_team` card payloads — the `input` of the `approval_request` row —
 * in the member shape a team has today. Each diff is what the daemon's
 * `diffTeams` and `agentsThatRunAuto` produce between the saved team and the
 * proposed one. `renderer/__fixtures__/team-proposals.ts` holds the same four
 * cards as they were recorded while teams were node graphs.
 */

const CODER_ASKS = {
  'id': 'coder',
  'name': 'Coder',
  'agent': 'claude',
  'approval': 'ask',
};

const REVIEWER_ASKS = {
  'id': 'reviewer',
  'name': 'Reviewer',
  'agent': 'claude',
  'approval': 'ask',
};

const FIRST_MESSAGE_TO_CODER = [{ 'kind': 'first-message', 'member': 'coder' }];

export const RECORDED_NEW_PROPOSAL: unknown = {
  'mode': 'create',
  'autoAgents': ['Reviewer (reviewer)'],
  'summary':
    'The first message goes to a coder (asks before using tools), who hands the work to a reviewer (runs tools without asking).',
  'slug': 'review-pair',
  'team': {
    'name': 'Review Pair',
    'mode': 'lead',
    'members': [CODER_ASKS, { ...REVIEWER_ASKS, 'approval': 'auto' }],
    'triggers': FIRST_MESSAGE_TO_CODER,
    'instructionBlocks': [],
  },
};

export const RECORDED_REPLACE_PROPOSAL: unknown = {
  'mode': 'replace',
  'autoAgents': [],
  'summary': "Set the reviewer's approval to ask.",
  'slug': 'review-pair',
  'replacesName': 'Review Pair',
  'diff': {
    'identical': false,
    'teamFields': [],
    'addedMembers': [],
    'removedMembers': [],
    'changedMembers': [
      {
        'id': 'reviewer',
        'fields': [
          {
            'field': 'approval',
            'before': '"auto"',
            'after': '"ask"',
          },
        ],
      },
    ],
    'addedBlocks': [],
    'removedBlocks': [],
    'changedBlocks': [],
    'addedStages': [],
    'removedStages': [],
    'changedStages': [],
  },
  'baseHash': 'ee8c95bacfb3ad04',
  'team': {
    'name': 'Review Pair',
    'mode': 'lead',
    'members': [CODER_ASKS, REVIEWER_ASKS],
    'triggers': FIRST_MESSAGE_TO_CODER,
    'instructionBlocks': [],
  },
};

export const REPLACE_TO_AUTO_PROPOSAL: unknown = {
  'mode': 'replace',
  'autoAgents': ['Coder (coder)', 'Tester (tester) — pool member 2'],
  'summary':
    'Add a tester between the coder and the reviewer; the coder now runs without asking.',
  'reason':
    'The user asked for tests before review.\nThe coder waited on every edit, so it now runs unattended.',
  'slug': 'review-pair',
  'replacesName': 'Review Pair',
  'diff': {
    'identical': false,
    'teamFields': [
      {
        'field': 'description',
        'before': '"A coder and a reviewer."',
        'after': '"A coder, a tester and a reviewer."',
      },
    ],
    'addedMembers': ['tester'],
    'removedMembers': [],
    'changedMembers': [
      {
        'id': 'coder',
        'fields': [
          {
            'field': 'approval',
            'before': '"ask"',
            'after': '"auto"',
          },
          {
            'field': 'model',
            'before': '(unset)',
            'after': '"sonnet"',
          },
          {
            'field': 'effort',
            'before': '(unset)',
            'after': '"high"',
          },
          {
            'field': 'instructions',
            'before': '(unset)',
            'after':
              '"Implement the change the trigger describes, with tests."',
          },
        ],
      },
      {
        'id': 'reviewer',
        'fields': [
          {
            'field': 'approval',
            'before': '"auto"',
            'after': '"ask"',
          },
        ],
      },
    ],
    'addedBlocks': ['style'],
    'removedBlocks': [],
    'changedBlocks': [],
    'addedStages': [],
    'removedStages': [],
    'changedStages': [],
  },
  'baseHash': 'ee8c95bacfb3ad04',
  'team': {
    'name': 'Review Pair',
    'description': 'A coder, a tester and a reviewer.',
    'mode': 'lead',
    'members': [
      {
        ...CODER_ASKS,
        'model': 'sonnet',
        'effort': 'high',
        'approval': 'auto',
        'role': 'Writes the change',
        'instructions':
          'Implement the change the trigger describes, with tests.',
      },
      {
        'id': 'tester',
        'name': 'Tester',
        'agent': 'codex',
        'approval': 'acceptEdits',
        'role': 'Runs the suite',
        'instructions': 'Run the suite and report failures.',
        'pool': [
          {
            'agent': 'cursor-agent',
            'approval': 'auto',
          },
        ],
      },
      REVIEWER_ASKS,
    ],
    'triggers': FIRST_MESSAGE_TO_CODER,
    'instructionBlocks': [
      {
        'id': 'style',
        'title': 'Style',
        'text': 'Follow the repository conventions in AGENTS.md.',
        'audience': ['coder'],
      },
    ],
  },
};

export const STAGES_PROPOSAL: unknown = {
  'mode': 'replace',
  'autoAgents': [],
  'summary': 'Walk every run through plan, build and review.',
  'reason': 'The user asked for a review step after the build.',
  'slug': 'review-pair',
  'replacesName': 'Review Pair',
  'diff': {
    'identical': false,
    'teamFields': [],
    'addedMembers': [],
    'removedMembers': [],
    'changedMembers': [],
    'addedBlocks': [],
    'removedBlocks': [],
    'changedBlocks': [],
    'addedStages': ['review'],
    'removedStages': [
      {
        'id': 'ship',
        'fields': [
          { 'field': 'title', 'before': '"Ship"', 'after': '(unset)' },
          {
            'field': 'goal',
            'before': '"The change is merged."',
            'after': '(unset)',
          },
        ],
      },
    ],
    'changedStages': [
      {
        'id': 'build',
        'fields': [
          {
            'field': 'next',
            'before': '["ship"]',
            'after': '["review"]',
          },
        ],
      },
    ],
  },
  'baseHash': 'ee8c95bacfb3ad04',
  'team': {
    'name': 'Review Pair',
    'mode': 'lead',
    'members': [CODER_ASKS, REVIEWER_ASKS],
    'triggers': FIRST_MESSAGE_TO_CODER,
    'instructionBlocks': [],
    'stages': [
      {
        'id': 'plan',
        'title': 'Plan',
        'goal': 'The approach is agreed.',
        'next': ['build'],
      },
      {
        'id': 'build',
        'title': 'Build',
        'goal': 'The change is implemented with tests.',
        'responsible': ['coder'],
        'next': ['review'],
      },
      {
        'id': 'review',
        'title': 'Review',
        'goal': 'The reviewer approved the change.',
        'responsible': ['reviewer'],
      },
    ],
  },
};

const BILLING_OVERLAY_DIFF = [
  '--- billing/review-pair.overlay.yaml',
  '+++ billing/review-pair.overlay.yaml',
  '@@ -1,3 +1,5 @@',
  ' members:',
  '   reviewer:',
  '-    model: sonnet',
  '+    model: opus',
  '+    effort: high',
  ' ',
].join('\n');

export const BILLING_OVERLAY: unknown = {
  'projectId': 'p-billing',
  'projectName': 'Billing',
  'overlay': {
    'members': { 'reviewer': { 'model': 'opus', 'effort': 'high' } },
  },
  'baseHash': '9f2c41d07a1b3e55',
  'diffText': BILLING_OVERLAY_DIFF,
};

/** The recorded replacement with a change to one project's overlay beside it. */
export const REPLACE_WITH_OVERLAY_PROPOSAL: unknown = {
  ...(RECORDED_REPLACE_PROPOSAL as object),
  'overlay': BILLING_OVERLAY,
};

/** Only the overlay changes: the shared team is unchanged. */
export const OVERLAY_ONLY_PROPOSAL: unknown = {
  ...(RECORDED_REPLACE_PROPOSAL as object),
  'summary': "Run Billing's reviewer on opus.",
  'diff': {
    'identical': true,
    'teamFields': [],
    'addedMembers': [],
    'removedMembers': [],
    'changedMembers': [],
    'addedBlocks': [],
    'removedBlocks': [],
    'changedBlocks': [],
    'addedStages': [],
    'removedStages': [],
    'changedStages': [],
  },
  'overlay': BILLING_OVERLAY,
};

const BILLING_INSTRUCTIONS_DIFF = [
  '@@ -1,3 +1,7 @@',
  ' ## Repo',
  ' ',
  ' Use pnpm.',
  '+',
  '+## Visuals',
  '+',
  '+Attach before/after screenshots to every pull request.',
].join('\n');

/** A replacement that moves a rule out of the team into one project's instructions, on the same card. */
export const MOVE_TO_PROJECT_PROPOSAL: unknown = {
  ...(RECORDED_REPLACE_PROPOSAL as object),
  'summary': 'Visuals move to Billing',
  'project': {
    'projectId': 'p-billing',
    'projectName': 'Billing',
    'blocks': [
      { 'id': 'repo', 'title': 'Repo', 'text': 'Use pnpm.' },
      {
        'id': 'visuals',
        'title': 'Visuals',
        'text': 'Attach before/after screenshots to every pull request.',
      },
    ],
    'baseRevision': 2,
    'diffText': BILLING_INSTRUCTIONS_DIFF,
  },
};

/**
 * `run_team` card payloads: the `input` of the approval_request row in the
 * shape the daemon writes (`RunStartProposalSchema` / `RunChangeProposalSchema`).
 * The team is the one the run would have, its lead this chat's own agent.
 */
const CHAT_LEAD = {
  memberId: 'agent',
  name: 'Chat agent',
  role: 'Coordinates the team',
  agent: 'claude',
  model: null,
  approval: 'ask',
};

export const RUN_START_PROPOSAL: unknown = {
  'mode': 'run-start',
  'autoAgents': ['Reviewer'],
  'summary':
    'A coder writes the parser change; a reviewer checks it without asking.',
  'reason': 'The change is split across two agents with separate jobs.',
  'slug': '',
  'team': {
    'name': 'Chat team',
    'mode': 'lead',
    'members': [CODER_ASKS, { ...REVIEWER_ASKS, 'approval': 'auto' }],
    'triggers': FIRST_MESSAGE_TO_CODER,
    'instructionBlocks': [],
  },
  'plan': [
    'Coder changes the parser and the card',
    'Reviewer reads the diff and runs the specs',
    'This chat merges the two results',
  ],
  'lead': CHAT_LEAD,
  'members': [
    {
      'member': {
        'memberId': 'coder',
        'name': 'Coder',
        'role': 'Writes the change',
        'agent': 'claude',
        'model': 'sonnet',
        'approval': 'ask',
      },
      'task': 'Change the parser and the card',
    },
    {
      'member': {
        'memberId': 'reviewer',
        'name': 'Reviewer',
        'role': 'Reads the diff',
        'agent': 'codex',
        'model': null,
        'approval': 'auto',
      },
      'task': 'Read the diff and run the specs',
    },
  ],
};

const COACH_INSTRUCTIONS_BEFORE =
  'Keep the coder to the parser and the card; leave the store alone.';
const COACH_INSTRUCTIONS_AFTER =
  'Keep the coder to the parser, the card and their specs; leave the store alone and ask before touching the daemon.';

export const RUN_CHANGE_PROPOSAL: unknown = {
  'mode': 'run-change',
  'autoAgents': ['Tester'],
  'summary': 'Adds a tester, retires the reviewer and widens the coder.',
  'reason': 'The specs need a runner before the change ships.',
  'slug': 'chat-team',
  'baseHash': 'a1b2c3',
  'team': {
    'name': 'Chat team',
    'mode': 'lead',
    'members': [CODER_ASKS],
    'triggers': FIRST_MESSAGE_TO_CODER,
    'instructionBlocks': [],
  },
  'changes': [
    {
      'op': 'add',
      'member': {
        'memberId': 'tester',
        'name': 'Tester',
        'role': 'Runs the checks',
        'agent': 'claude',
        'model': null,
        'approval': 'auto',
      },
      'task': 'Run the test suite after each change',
    },
    { 'op': 'remove', 'memberId': 'reviewer', 'name': 'Reviewer' },
    {
      'op': 'update',
      'memberId': 'coder',
      'name': 'Coder',
      'fields': [
        {
          'field': 'role',
          'before': 'Writes the change',
          'after': 'Writes the change and its tests',
        },
        {
          'field': 'instructions',
          'before': COACH_INSTRUCTIONS_BEFORE,
          'after': COACH_INSTRUCTIONS_AFTER,
        },
      ],
      'task': null,
    },
  ],
};
