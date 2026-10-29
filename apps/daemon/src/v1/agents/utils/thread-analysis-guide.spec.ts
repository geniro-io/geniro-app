import { describe, expect, it } from 'vitest';

import { reportRecommendationsInstructions } from '../../mcp/tools/report-recommendations/report-recommendations.instructions';
import {
  HOST_CHART_TOOL,
  HOST_MEMORY_FORGET_TOOL,
  HOST_MEMORY_SAVE_TOOL,
  HOST_METRICS_TOOL,
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
    const guide = threadAnalysisGuide('workflow', null, true);

    expect(guide).toContain('This is a WORKFLOW thread');
    expect(guide).toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).toContain('W-1, W-2');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('M-1, M-2');
    expect(guide).toContain('Recommend changes of four kinds');
    expect(guide).toContain(
      'view=workflow lists them under `userInstructions`',
    );
  });

  it('keeps a plain chat to repo and user changes and never names the workflow save', () => {
    const guide = threadAnalysisGuide('chat', null, true);

    expect(guide).toContain('Never recommend a workflow change');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('M-1, M-2');
    expect(guide).toContain('target "memory"');
    expect(guide).toContain('`source.userInstructions`');
    expect(guide).not.toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).not.toContain('W-1');
    expect(guide).toContain(HOST_RECOMMENDATIONS_TOOL);
  });

  it('applies a memory item through the memory tools, and does not retry a refusal under review', () => {
    for (const guide of [
      threadAnalysisGuide('chat', null, true),
      threadAnalysisGuide('workflow', null, true),
      workflowAnalysisGuide(null, true),
    ]) {
      expect(guide).toContain(
        `- Memory items: add — call \`${HOST_MEMORY_SAVE_TOOL}\``,
      );
      expect(guide).toContain(
        `call \`${HOST_MEMORY_FORGET_TOOL}\` with that handle and a reason`,
      );
      expect(guide).toContain('refused UNDER_REVIEW: do not retry it');
      expect(guide).toContain('add, update or forget');
    }
  });

  it("has the analyst read the repo's own checks and place each fix on the lowest rung", () => {
    for (const kind of ['chat', 'workflow'] as const) {
      const guide = threadAnalysisGuide(kind, null, true);

      expect(guide).toContain("Read the working folder's package.json scripts");
      expect(guide).toContain('## Where a fix belongs');
      expect(guide).toContain('1. A deterministic check');
    }
  });

  it('has every item keep to one territory, process or domain, and split one that needs both', () => {
    for (const kind of ['chat', 'workflow'] as const) {
      const guide = threadAnalysisGuide(kind, null, true);

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
    expect(
      threadAnalysisGuide('chat', '  why so many reviews?  ', true),
    ).toContain(
      "## The user's focus for this analysis\n\nwhy so many reviews?",
    );
    expect(threadAnalysisGuide('chat', '   ', true)).not.toContain(
      "user's focus",
    );
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
    const guide = workflowAnalysisGuide(null, true);

    expect(guide).toContain('# Workflow analysis');
    expect(guide).toContain('Read view=runs first');
    expect(guide).toContain('3. Model effectiveness.');
    expect(guide).toContain('recommend nothing from a single sample');
    expect(guide).toContain('4. Graph structure.');
    expect(guide).toContain('its `runId` and seq');
  });

  it('offers workflow, repo and user changes and the workflow save', () => {
    const guide = workflowAnalysisGuide(null, true);

    expect(guide).toContain('W-1, W-2');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('M-1, M-2');
    expect(guide).toContain('target "memory"');
    expect(guide).toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).toContain('## Two territories: process and domain');
    expect(guide).toContain('## Where a fix belongs');
  });

  it("has the analyst measure every agent's instructions and grade them on five marks", () => {
    const guide = workflowAnalysisGuide(null, true);

    expect(guide).toContain('5. Instruction size. Read view=workflow');
    expect(guide).toContain('`instructionSizes`');
    expect(guide).toContain('`inThisRun`');
    expect(guide).toContain('6. Instruction quality.');
    for (const mark of [
      'clear (',
      'specific (',
      'consistent (',
      'lean (',
      'followed (',
    ]) {
      expect(guide).toContain(mark);
    }
  });

  it('asks for the whole report in the reply, section by section, before the card', () => {
    const guide = workflowAnalysisGuide(null, true);
    const report = guide.indexOf('## The report');
    const send = guide.indexOf('## What to send');
    const sections = [
      `1. Headline — one \`${HOST_METRICS_TOOL}\` scorecard`,
      '2. Time per run — a table',
      `3. Time per agent — one \`${HOST_CHART_TOOL}\` bar chart`,
      '4. Calls between agents',
      '5. Models — a table per agent and model',
      '6. Instruction size — a table per agent',
      '7. Instruction quality — a table per agent',
      '8. Where the time went',
      '9. The one change that matters most',
    ].map((section) => guide.indexOf(section, report));

    expect(report).toBeGreaterThan(-1);
    expect(sections).not.toContain(-1);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
    expect(sections.at(-1)!).toBeLessThan(send);
    expect(guide).toContain('write "not measured" for a null');
    expect(guide.slice(send)).toContain(
      '1. The report above, whole, in your reply',
    );
    expect(guide).not.toContain('A short summary in your reply');
  });

  it("adds the user's focus as its own section", () => {
    expect(workflowAnalysisGuide(' cheaper reviews ', true)).toContain(
      "## The user's focus for this analysis\n\ncheaper reviews",
    );
  });
});

describe('workflowAnalysisBrief', () => {
  it('names the workflow, how many runs, and where to start', () => {
    expect(workflowAnalysisBrief({ name: 'Dev Team', runs: 5 })).toBe(
      'Analyse the workflow "Dev Team" across its 5 latest runs: report how long each run and each agent worked, how large and how good each agent\'s instructions are, and how its agents and their models compare, and find what in the workflow or its environment would make the next runs faster, cheaper or less error-prone. Start with read_analyzed_thread view=runs.',
    );
    expect(workflowAnalysisBrief({ name: 'Dev Team', runs: 1 })).toContain(
      'across its latest run:',
    );
  });

  it('leaves the memory target out entirely while the shared memory is off', () => {
    for (const guide of [
      threadAnalysisGuide('chat', null, false),
      threadAnalysisGuide('workflow', null, false),
      workflowAnalysisGuide(null, false),
    ]) {
      expect(guide).not.toContain('target "memory"');
      expect(guide).not.toContain('M-1');
      expect(guide).not.toContain('Memory items:');
      expect(guide).not.toContain('memory item');
    }
    expect(threadAnalysisGuide('workflow', null, false)).toContain(
      'changes of three kinds',
    );
  });
});

describe('reportRecommendationsInstructions', () => {
  it('names M- ids only while the shared memory is on', () => {
    expect(reportRecommendationsInstructions(true)).toContain('M-1, M-2');
    expect(reportRecommendationsInstructions(false)).not.toContain('M-1');
  });
});
