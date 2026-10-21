/**
 * `propose_workflow` card payloads — the `input` of the `approval_request` row.
 *
 * The first two were read back from a real run's `geniro.db` (milestone 1's
 * walk: a claude chat proposing a new workflow, then a cursor chat proposing
 * its replacement). The third was produced by the daemon's own
 * `diffWorkflows` and `agentsThatRunAuto` over the first workflow and a richer
 * replacement, because no recorded run switched an agent to `auto`.
 */

export const RECORDED_NEW_PROPOSAL: unknown = {
  'mode': 'create',
  'autoAgents': ['reviewer'],
  'summary':
    'Manual trigger feeds a coder agent (asks before using tools), whose output goes to a reviewer agent (runs tools without asking).',
  'slug': 'review-pair',
  'workflow': {
    'name': 'Review Pair',
    'nodes': [
      {
        'id': 'start',
        'kind': 'trigger',
        'trigger': 'manual',
      },
      {
        'id': 'coder',
        'kind': 'agent',
        'agent': 'claude',
        'approval': 'ask',
      },
      {
        'id': 'reviewer',
        'kind': 'agent',
        'agent': 'claude',
        'approval': 'auto',
      },
    ],
    'edges': [
      {
        'from': 'start',
        'to': 'coder',
        'kind': 'data',
      },
      {
        'from': 'coder',
        'to': 'reviewer',
        'kind': 'data',
      },
    ],
  },
};

export const RECORDED_REPLACE_PROPOSAL: unknown = {
  'mode': 'replace',
  'autoAgents': [],
  'summary': "Set the reviewer agent's approval to ask.",
  'slug': 'review-pair',
  'replacesName': 'Review Pair',
  'diff': {
    'identical': false,
    'workflowFields': [],
    'addedNodes': [],
    'removedNodes': [],
    'changedNodes': [
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
    'addedEdges': [],
    'removedEdges': [],
  },
  'baseHash': 'ee8c95bacfb3ad04',
  'workflow': {
    'name': 'Review Pair',
    'nodes': [
      {
        'id': 'start',
        'kind': 'trigger',
        'trigger': 'manual',
      },
      {
        'id': 'coder',
        'kind': 'agent',
        'agent': 'claude',
        'approval': 'ask',
      },
      {
        'id': 'reviewer',
        'kind': 'agent',
        'agent': 'claude',
        'approval': 'ask',
      },
    ],
    'edges': [
      {
        'from': 'start',
        'to': 'coder',
        'kind': 'data',
      },
      {
        'from': 'coder',
        'to': 'reviewer',
        'kind': 'data',
      },
    ],
  },
};

export const REPLACE_TO_AUTO_PROPOSAL: unknown = {
  'mode': 'replace',
  'autoAgents': ['Coder (coder)', 'Tester (tester) — pool member 2'],
  'summary':
    'Add a tester between the coder and the reviewer; the coder now runs without asking.',
  'slug': 'review-pair',
  'replacesName': 'Review Pair',
  'diff': {
    'identical': false,
    'workflowFields': ['description'],
    'addedNodes': ['tester', 'style'],
    'removedNodes': [],
    'changedNodes': [
      {
        'id': 'coder',
        'fields': [
          {
            'field': 'approval',
            'before': '"ask"',
            'after': '"auto"',
          },
          {
            'field': 'name',
            'before': '(unset)',
            'after': '"Coder"',
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
            'field': 'role',
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
    'addedEdges': [
      'coder → tester (data)',
      'tester → reviewer (data)',
      'style → coder (instruction)',
    ],
    'removedEdges': ['coder → reviewer (data)'],
  },
  'baseHash': 'ee8c95bacfb3ad04',
  'workflow': {
    'name': 'Review Pair',
    'description': 'A coder, a tester and a reviewer.',
    'nodes': [
      {
        'id': 'start',
        'kind': 'trigger',
        'trigger': 'manual',
      },
      {
        'id': 'coder',
        'kind': 'agent',
        'name': 'Coder',
        'agent': 'claude',
        'model': 'sonnet',
        'effort': 'high',
        'approval': 'auto',
        'role': 'Implement the change the trigger describes, with tests.',
      },
      {
        'id': 'tester',
        'kind': 'agent',
        'name': 'Tester',
        'agent': 'codex',
        'approval': 'acceptEdits',
        'role': 'Run the suite and report failures.',
        'pool': [
          {
            'agent': 'cursor-agent',
            'approval': 'auto',
          },
        ],
      },
      {
        'id': 'reviewer',
        'kind': 'agent',
        'agent': 'claude',
        'approval': 'ask',
      },
      {
        'id': 'style',
        'kind': 'instruction',
        'name': 'Style',
        'instructions': 'Follow the repository conventions in AGENTS.md.',
      },
    ],
    'edges': [
      {
        'from': 'start',
        'to': 'coder',
        'kind': 'data',
      },
      {
        'from': 'coder',
        'to': 'tester',
        'kind': 'data',
      },
      {
        'from': 'tester',
        'to': 'reviewer',
        'kind': 'data',
      },
      {
        'from': 'style',
        'to': 'coder',
        'kind': 'instruction',
      },
    ],
  },
};
