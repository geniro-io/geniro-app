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
    'teamFields': ['description'],
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
    'removedStages': ['ship'],
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
