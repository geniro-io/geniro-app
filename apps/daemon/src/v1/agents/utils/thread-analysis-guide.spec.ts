import { describe, expect, it } from 'vitest';

import { reportRecommendationsInstructions } from '../../mcp/tools/report-recommendations/report-recommendations.instructions';
import {
  HOST_CHART_TOOL,
  HOST_MEMORY_FORGET_TOOL,
  HOST_MEMORY_SAVE_TOOL,
  HOST_METRICS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../chat.types';
import {
  teamAnalysisBrief,
  teamAnalysisGuide,
  threadAnalysisBrief,
  threadAnalysisGuide,
} from './thread-analysis-guide';

describe('threadAnalysisGuide', () => {
  it('offers team, repo and user changes, and the team save, for a team thread', () => {
    const guide = threadAnalysisGuide('team', null, true);

    expect(guide).toContain('This is a TEAM thread');
    expect(guide).toContain(HOST_TEAM_CHANGE_TOOL);
    expect(guide).toContain('W-1, W-2');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('M-1, M-2');
    expect(guide).toContain('Recommend changes of four kinds');
    expect(guide).toContain('view=team lists them under `userInstructions`');
  });

  it('keeps a plain chat to repo and user changes and never names the team save', () => {
    const guide = threadAnalysisGuide('chat', null, true);

    expect(guide).toContain('Never recommend a team change');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('M-1, M-2');
    expect(guide).toContain('target "memory"');
    expect(guide).toContain('`source.userInstructions`');
    expect(guide).not.toContain(HOST_TEAM_CHANGE_TOOL);
    expect(guide).not.toContain('W-1');
    expect(guide).toContain(HOST_RECOMMENDATIONS_TOOL);
  });

  it('applies a memory item through the memory tools, and does not retry a refusal under review', () => {
    for (const guide of [
      threadAnalysisGuide('chat', null, true),
      threadAnalysisGuide('team', null, true),
      teamAnalysisGuide(null, true),
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
    for (const kind of ['chat', 'team'] as const) {
      const guide = threadAnalysisGuide(kind, null, true);

      expect(guide).toContain(
        'Read the package.json scripts (lint, typecheck, test, check), the CI workflow and the git hooks of the working folder yourself',
      );
      expect(guide).toContain('## Where a fix belongs');
      expect(guide).toContain('1. A deterministic check');
    }
  });

  it('has every item keep to one territory, process or domain, and split one that needs both', () => {
    for (const kind of ['chat', 'team'] as const) {
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
    expect(threadAnalysisBrief({ title: 'Dev Team run', kind: 'team' })).toBe(
      'Analyse "Dev Team run" (a team thread): find where its time went and what in its environment would make the next run faster or less error-prone. Start with read_analyzed_thread view=overview.',
    );
  });
});

describe('teamAnalysisGuide', () => {
  it('starts from the history, then the cross-run comparison, and asks for models and the team structure', () => {
    const guide = teamAnalysisGuide(null, true);

    expect(guide).toContain('# Team analysis');
    expect(guide.indexOf('1. History. Read view=history first')).toBeLessThan(
      guide.indexOf('2. Compare the runs. Read view=runs next'),
    );
    expect(guide).toContain('7. Model effectiveness.');
    expect(guide).toContain('recommend nothing from a single sample');
    expect(guide).toContain('8. Team structure.');
    expect(guide).toContain('its `runId` and seq');
  });

  it('has the analyst judge the earlier changes by their runs and not repeat what the user passed over', () => {
    const guide = teamAnalysisGuide(null, true);

    expect(guide).toContain('3. Versions, not one pool.');
    expect(guide).toContain(
      'A problem seen only in runs older than a change that addressed it is not a finding',
    );
    expect(guide).toContain('4. Earlier changes.');
    expect(guide).toContain('helped, no effect, worse, or too few runs');
    expect(guide).toContain('kind "revert"');
    expect(guide).toContain('5. Earlier recommendations.');
    expect(guide).toContain(
      'Never recommend again what the user skipped or passed over (not-selected) unless runs since then show new evidence',
    );
    expect(guide).toContain('Set every item against view=history');
  });

  it('offers team, repo and user changes and the team save', () => {
    const guide = teamAnalysisGuide(null, true);

    expect(guide).toContain('W-1, W-2');
    expect(guide).toContain('U-1, U-2');
    expect(guide).toContain('M-1, M-2');
    expect(guide).toContain('target "memory"');
    expect(guide).toContain(HOST_TEAM_CHANGE_TOOL);
    expect(guide).toContain('## Two territories: process and domain');
    expect(guide).toContain('## Where a fix belongs');
  });

  it("has the analyst measure every agent's instructions and grade them on five marks", () => {
    const guide = teamAnalysisGuide(null, true);

    expect(guide).toContain('9. Instruction size. Read view=team');
    expect(guide).toContain('`instructionSizes`');
    expect(guide).toContain('`inThisRun`');
    expect(guide).toContain('10. Instruction quality.');
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

  it('asks the reply for what the card does not draw, section by section, before the card, and nothing the card does', () => {
    const guide = teamAnalysisGuide(null, true);
    const report = guide.indexOf('## The report');
    const send = guide.indexOf('## What to send');
    const sections = [
      '1. Versions and earlier changes — a table per version that has runs',
      '2. Outcomes — a table per run, newest first: its questions to the user',
      "3. Models — your verdict on each agent's model and effort",
      '4. Instruction size — a table per agent',
      '5. Instruction quality — a table per agent',
      '6. The one change that matters most',
    ].map((section) => guide.indexOf(section, report));

    expect(report).toBeGreaterThan(-1);
    expect(sections).not.toContain(-1);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
    expect(sections.at(-1)!).toBeLessThan(send);
    expect(guide).toContain(
      'Never repeat those in your reply: no scorecard, chart or table of them.',
    );
    expect(guide).not.toContain(HOST_METRICS_TOOL);
    expect(guide).not.toContain(HOST_CHART_TOOL);
    expect(guide).not.toContain('Time per run — a table');
    expect(guide).toContain('write "not measured" for a null');
    expect(guide.slice(send)).toContain(
      '1. The report above, whole, in your reply',
    );
    expect(guide).not.toContain('A short summary in your reply');
  });

  it('files again what a replaced card left unanswered, but not what the user passed over', () => {
    const guide = teamAnalysisGuide(null, true);

    expect(guide).toContain(
      'unanswered (its card was replaced before the user applied anything from it)',
    );
    expect(guide).toContain(
      'An unanswered one was never decided: file it again when the runs still call for it.',
    );
    expect(guide).toContain(
      'Never recommend again what the user skipped or passed over (not-selected)',
    );
  });

  it("adds the user's focus as its own section", () => {
    expect(teamAnalysisGuide(' cheaper reviews ', true)).toContain(
      "## The user's focus for this analysis\n\ncheaper reviews",
    );
  });
});

describe('teamAnalysisBrief', () => {
  it('names the team, how many runs, and where to start', () => {
    expect(teamAnalysisBrief({ name: 'Dev Team', runs: 5 })).toBe(
      "Analyse the team \"Dev Team\" across its 5 latest runs: explain where its runs' time and money went and why, how large and how good each agent's instructions are, how its agents' models fit their work, and how the earlier changes to it worked out, and find what in the team or its environment would make the next runs faster, cheaper or less error-prone. Start with read_analyzed_thread view=history, then view=runs.",
    );
    expect(teamAnalysisBrief({ name: 'Dev Team', runs: 1 })).toContain(
      'across its latest run:',
    );
  });

  it('leaves the memory target out entirely while the shared memory is off', () => {
    for (const guide of [
      threadAnalysisGuide('chat', null, false),
      threadAnalysisGuide('team', null, false),
      teamAnalysisGuide(null, false),
    ]) {
      expect(guide).not.toContain('target "memory"');
      expect(guide).not.toContain('M-1');
      expect(guide).not.toContain('Memory items:');
      expect(guide).not.toContain('memory item');
    }
    expect(threadAnalysisGuide('team', null, false)).toContain(
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
