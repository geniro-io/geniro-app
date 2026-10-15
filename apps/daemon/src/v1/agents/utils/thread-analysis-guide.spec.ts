import { describe, expect, it } from 'vitest';

import {
  HOST_RECOMMENDATIONS_TOOL,
  HOST_WORKFLOW_CHANGE_TOOL,
} from '../chat.types';
import {
  threadAnalysisBrief,
  threadAnalysisGuide,
} from './thread-analysis-guide';

describe('threadAnalysisGuide', () => {
  it('offers workflow and repo changes, and the workflow save, for a workflow thread', () => {
    const guide = threadAnalysisGuide('workflow', null);

    expect(guide).toContain('This is a WORKFLOW thread');
    expect(guide).toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).toContain('W-1, W-2');
  });

  it('keeps a plain chat to repo changes and never names the workflow save', () => {
    const guide = threadAnalysisGuide('chat', null);

    expect(guide).toContain('repository changes only');
    expect(guide).not.toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).not.toContain('W-1');
    expect(guide).toContain(HOST_RECOMMENDATIONS_TOOL);
  });

  it("adds the user's focus as its own section, and nothing for a blank one", () => {
    expect(threadAnalysisGuide('chat', '  why so many reviews?  ')).toContain(
      "## The user's focus for this analysis\n\nwhy so many reviews?",
    );
    expect(threadAnalysisGuide('chat', '   ')).not.toContain("user's focus");
  });
});

describe('threadAnalysisBrief', () => {
  it('names the source and where to start', () => {
    expect(
      threadAnalysisBrief({ title: 'Dev Team run', kind: 'workflow' }),
    ).toBe(
      'Analyse "Dev Team run" (a workflow thread): find where its time went and what would make the next run faster. Start with read_analyzed_thread view=overview.',
    );
  });
});
