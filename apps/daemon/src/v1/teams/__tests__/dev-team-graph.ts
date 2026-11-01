import type { LegacyTeamGraph } from '../teams.types';

/**
 * The live Dev Team's shape as it stood while teams were node graphs: its
 * nodes, edges and stages, with every text replaced by a marker naming its
 * owner and every profile path dropped.
 */
export const DEV_TEAM_GRAPH: LegacyTeamGraph = {
  'name': 'Dev Team Manifest',
  'nodes': [
    {
      'id': 'trigger-1',
      'kind': 'trigger',
      'name': 'Request',
      'trigger': 'manual',
    },
    {
      'id': 'settings',
      'kind': 'instruction',
      'name': 'Team Settings',
      'instructions': 'BLOCK settings',
    },
    {
      'id': 'playbook',
      'kind': 'instruction',
      'name': 'Engineering Playbook',
      'instructions': 'BLOCK playbook',
    },
    {
      'id': 'review-standard',
      'kind': 'instruction',
      'name': 'Intent Review Standard',
      'instructions': 'BLOCK review-standard',
    },
    {
      'id': 'manager',
      'kind': 'agent',
      'name': 'Manager',
      'agent': 'claude',
      'approval': 'auto',
      'model': 'opus',
      'description': 'PUBLIC manager',
      'role': 'PRIVATE manager',
      'pool': [
        {
          'agent': 'cursor-agent',
          'model': 'gemini-4-argon',
        },
      ],
    },
    {
      'id': 'engineer',
      'kind': 'agent',
      'name': 'Senior Engineer',
      'agent': 'claude',
      'approval': 'auto',
      'model': 'opus',
      'description': 'PUBLIC engineer',
      'role': 'PRIVATE engineer',
      'pool': [
        {
          'agent': 'codex',
          'model': 'gpt-6.1-sol',
        },
        {
          'agent': 'cursor-agent',
          'model': 'grok-4.7',
        },
      ],
    },
    {
      'id': 'middle',
      'kind': 'agent',
      'name': 'Middle Engineer',
      'agent': 'claude',
      'approval': 'auto',
      'model': 'haiku',
      'description': 'PUBLIC middle',
      'role': 'PRIVATE middle',
      'pool': [
        {
          'agent': 'claude',
          'model': 'haiku',
        },
        {
          'agent': 'cursor-agent',
          'model': 'gemini-4-argon',
        },
      ],
    },
    {
      'id': 'researcher',
      'kind': 'agent',
      'name': 'Researcher',
      'agent': 'claude',
      'approval': 'auto',
      'model': 'opus',
      'description': 'PUBLIC researcher',
      'role': 'PRIVATE researcher',
      'pool': [
        {
          'agent': 'codex',
          'model': 'gpt-6.1-sol',
        },
        {
          'agent': 'cursor-agent',
          'model': 'gemini-4-argon',
        },
      ],
    },
    {
      'id': 'handyman',
      'kind': 'agent',
      'name': 'Handyman',
      'agent': 'cursor-agent',
      'approval': 'auto',
      'model': 'gemini-4-argon',
      'description': 'PUBLIC handyman',
      'role': 'PRIVATE handyman',
    },
    {
      'id': 'qa',
      'kind': 'agent',
      'name': 'QA',
      'agent': 'cursor-agent',
      'approval': 'auto',
      'model': 'gemini-4-argon',
      'description': 'PUBLIC qa',
      'role': 'PRIVATE qa',
      'pool': [
        {
          'agent': 'codex',
          'model': 'gpt-6.1-sol',
        },
      ],
    },
    {
      'id': 'browser-recipe',
      'kind': 'instruction',
      'name': 'Headless Browser Recipe',
      'instructions': 'BLOCK browser-recipe',
    },
    {
      'id': 'memory',
      'kind': 'instruction',
      'name': 'Team Memory',
      'instructions': 'BLOCK memory',
    },
  ],
  'edges': [
    {
      'from': 'trigger-1',
      'to': 'manager',
      'kind': 'data',
    },
    {
      'from': 'manager',
      'to': 'engineer',
      'kind': 'call',
    },
    {
      'from': 'manager',
      'to': 'researcher',
      'kind': 'call',
    },
    {
      'from': 'manager',
      'to': 'qa',
      'kind': 'call',
    },
    {
      'from': 'settings',
      'to': 'manager',
      'kind': 'instruction',
    },
    {
      'from': 'settings',
      'to': 'engineer',
      'kind': 'instruction',
    },
    {
      'from': 'settings',
      'to': 'researcher',
      'kind': 'instruction',
    },
    {
      'from': 'settings',
      'to': 'qa',
      'kind': 'instruction',
    },
    {
      'from': 'manager',
      'to': 'handyman',
      'kind': 'call',
    },
    {
      'from': 'engineer',
      'to': 'researcher',
      'kind': 'call',
    },
    {
      'from': 'settings',
      'to': 'handyman',
      'kind': 'instruction',
    },
    {
      'from': 'manager',
      'to': 'middle',
      'kind': 'call',
    },
    {
      'from': 'engineer',
      'to': 'middle',
      'kind': 'call',
    },
    {
      'from': 'middle',
      'to': 'researcher',
      'kind': 'call',
    },
    {
      'from': 'settings',
      'to': 'middle',
      'kind': 'instruction',
    },
    {
      'from': 'playbook',
      'to': 'engineer',
      'kind': 'instruction',
    },
    {
      'from': 'playbook',
      'to': 'middle',
      'kind': 'instruction',
    },
    {
      'from': 'review-standard',
      'to': 'qa',
      'kind': 'instruction',
    },
    {
      'from': 'review-standard',
      'to': 'engineer',
      'kind': 'instruction',
    },
    {
      'from': 'review-standard',
      'to': 'manager',
      'kind': 'instruction',
    },
    {
      'from': 'browser-recipe',
      'to': 'engineer',
      'kind': 'instruction',
    },
    {
      'from': 'browser-recipe',
      'to': 'middle',
      'kind': 'instruction',
    },
    {
      'from': 'browser-recipe',
      'to': 'qa',
      'kind': 'instruction',
    },
    {
      'from': 'memory',
      'to': 'manager',
      'kind': 'instruction',
    },
    {
      'from': 'memory',
      'to': 'engineer',
      'kind': 'instruction',
    },
    {
      'from': 'memory',
      'to': 'middle',
      'kind': 'instruction',
    },
    {
      'from': 'memory',
      'to': 'researcher',
      'kind': 'instruction',
    },
    {
      'from': 'memory',
      'to': 'handyman',
      'kind': 'instruction',
    },
    {
      'from': 'memory',
      'to': 'qa',
      'kind': 'instruction',
    },
  ],
  'stages': [
    {
      'id': 'triage',
      'title': 'Triage and run plan',
      'doneWhen': 'GOAL triage',
      'instructions': 'HOW triage',
      'ownerHint': 'manager',
      'next': ['plan', 'answer'],
    },
    {
      'id': 'plan',
      'title': 'Planning',
      'doneWhen': 'GOAL plan',
      'instructions': 'HOW plan',
      'ownerHint': 'researcher',
      'next': ['build'],
    },
    {
      'id': 'build',
      'title': 'Build or change',
      'doneWhen': 'GOAL build',
      'instructions': 'HOW build',
      'ownerHint': 'engineer',
      'next': ['agent-review'],
    },
    {
      'id': 'answer',
      'title': 'Answer, findings or small job',
      'doneWhen': 'GOAL answer',
      'instructions': 'HOW answer',
      'next': ['build', 'close-out'],
    },
    {
      'id': 'agent-review',
      'title': 'Agent review',
      'doneWhen': 'GOAL agent-review',
      'instructions': 'HOW agent-review',
      'ownerHint': 'qa',
      'next': ['verification'],
    },
    {
      'id': 'verification',
      'title': 'Verification on the stand',
      'doneWhen': 'GOAL verification',
      'instructions': 'HOW verification',
      'ownerHint': 'middle',
      'next': ['acceptance'],
    },
    {
      'id': 'acceptance',
      'title': 'User acceptance',
      'doneWhen': 'GOAL acceptance',
      'instructions': 'HOW acceptance',
      'ownerHint': 'manager',
      'next': ['pr-visuals'],
    },
    {
      'id': 'pr-visuals',
      'title': 'PR visuals',
      'doneWhen': 'GOAL pr-visuals',
      'instructions': 'HOW pr-visuals',
      'ownerHint': 'middle',
      'next': ['close-out'],
    },
    {
      'id': 'close-out',
      'title': 'Handoff and close-out',
      'doneWhen': 'GOAL close-out',
      'instructions': 'HOW close-out',
      'ownerHint': 'manager',
    },
  ],
};
