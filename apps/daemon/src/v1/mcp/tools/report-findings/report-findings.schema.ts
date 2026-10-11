import {
  FINDING_LEVELS,
  FINDING_OUTCOMES,
  FINDING_VERDICTS,
  MAX_FINDING_SHORT_SUMMARY_LENGTH,
  MAX_HOST_FINDINGS,
} from '../../../agents/chat.types';

/** `report_findings`'s arguments. */
export function reportFindingsSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: [...FINDING_LEVELS],
        description:
          'How deep the review that produced these findings ran. Optional.',
      },
      findings: {
        type: 'array',
        description: `The findings, most-severe first — at most ${MAX_HOST_FINDINGS}.`,
        items: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'Repo-relative path of the file the finding is in.',
            },
            line: {
              type: 'integer',
              description:
                'The 1-indexed line the finding anchors to. Omit rather than guessing — it is shown to the user as a location.',
            },
            summary: {
              type: 'string',
              description: 'One-sentence statement of the defect.',
            },
            short_summary: {
              type: 'string',
              description: `The claim alone, at most ${MAX_FINDING_SHORT_SUMMARY_LENGTH} characters — no rationale, no consequence clause. This is the collapsed row the user scans.`,
            },
            failure_scenario: {
              type: 'string',
              description:
                'Concrete inputs or state, and the wrong output or crash they produce.',
            },
            category: {
              type: 'string',
              description:
                'Short kebab-case slug of the finding type, e.g. "correctness", "security", "test-coverage". Optional.',
            },
            verdict: {
              type: 'string',
              enum: [...FINDING_VERDICTS],
              description:
                'Set only where a verification pass actually ran over this finding.',
            },
            outcome: {
              type: 'string',
              enum: [...FINDING_OUTCOMES],
              description:
                'Set ONLY when re-reporting after acting on the findings: what happened to this one.',
            },
          },
          required: ['file', 'summary', 'failure_scenario'],
        },
      },
    },
    required: ['findings'],
  };
}
