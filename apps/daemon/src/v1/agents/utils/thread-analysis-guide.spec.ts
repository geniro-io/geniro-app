import { describe, expect, it } from 'vitest';

import {
  HOST_RECOMMENDATIONS_TOOL,
  HOST_WORKFLOW_CHANGE_TOOL,
} from '../chat.types';
import {
  threadAnalysisBrief,
  threadAnalysisGuide,
  workflowAnalysisBrief,
  workflowAnalysisGuide,
} from './thread-analysis-guide';

describe('threadAnalysisGuide', () => {
  it('offers workflow, repo and user changes, and the workflow save, for a workflow thread', () => {
    const guide = threadAnalysisGuide('workflow', null);

    expect(guide).toContain('This is a WORKFLOW thread');
    expect(guide).toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).toContain('W-1, W-2');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain(
      'view=workflow lists them under `userInstructions`',
    );
  });

  it('keeps a plain chat to repo and user changes and never names the workflow save', () => {
    const guide = threadAnalysisGuide('chat', null);

    expect(guide).toContain('Never recommend a workflow change');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('`source.userInstructions`');
    expect(guide).not.toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).not.toContain('W-1');
    expect(guide).toContain(HOST_RECOMMENDATIONS_TOOL);
  });

  it("has the analyst read the repo's own checks and place each fix on the lowest rung", () => {
    for (const kind of ['chat', 'workflow'] as const) {
      const guide = threadAnalysisGuide(kind, null);

      expect(guide).toContain("Read the working folder's package.json scripts");
      expect(guide).toContain('## Where a fix belongs');
      expect(guide).toContain('1. A deterministic check');
    }
  });

  it('has every item keep to one territory, process or domain, and split one that needs both', () => {
    for (const kind of ['chat', 'workflow'] as const) {
      const guide = threadAnalysisGuide(kind, null);

      expect(guide).toContain('## Two territories: process and domain');
      expect(guide).toContain('named in `territory`');
      expect(guide).toContain('- process — how the agents work');
      expect(guide).toContain(
        '- domain — knowledge, procedures and constraints of the work itself',
      );
      expect(guide).toContain(
        'one that exists only because of this project (its scripts, its invariants, a new check enforcing a fact about it) is domain; when, whether and in what order the agents run commands and checks is process',
      );
      expect(guide).toContain('Never mix the two in one item');
      expect(guide).toContain('file two items, each with its own evidence');
    }
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
      'Analyse "Dev Team run" (a workflow thread): find where its time went and what in its environment would make the next run faster or less error-prone. Start with read_analyzed_thread view=overview.',
    );
  });
});

describe('workflowAnalysisGuide', () => {
  it('starts from the cross-run comparison and asks for models and the graph', () => {
    const guide = workflowAnalysisGuide(null);

    expect(guide).toContain('# Workflow analysis');
    expect(guide).toContain('Read view=runs first');
    expect(guide).toContain('3. Model effectiveness.');
    expect(guide).toContain('recommend nothing from a single sample');
    expect(guide).toContain('4. Graph structure.');
    expect(guide).toContain('its `runId` and seq');
  });

  it('offers workflow, repo and user changes and the workflow save', () => {
    const guide = workflowAnalysisGuide(null);

    expect(guide).toContain('W-1, W-2');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).toContain('## Two territories: process and domain');
    expect(guide).toContain('## Where a fix belongs');
  });

  it("adds the user's focus as its own section", () => {
    expect(workflowAnalysisGuide(' cheaper reviews ')).toContain(
      "## The user's focus for this analysis\n\ncheaper reviews",
    );
  });
});

describe('workflowAnalysisBrief', () => {
  it('names the workflow, how many runs, and where to start', () => {
    expect(workflowAnalysisBrief({ name: 'Dev Team', runs: 5 })).toBe(
      'Analyse the workflow "Dev Team" across its 5 latest runs: compare how its agents and their models did, and find what in the workflow or its environment would make the next runs faster, cheaper or less error-prone. Start with read_analyzed_thread view=runs.',
    );
    expect(workflowAnalysisBrief({ name: 'Dev Team', runs: 1 })).toContain(
      'across its latest run:',
    );
  });
});
