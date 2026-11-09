import { describe, expect, it } from 'vitest';

import { reportRecommendationsInstructions } from '../../mcp/tools/report-recommendations/report-recommendations.instructions';
import {
  HOST_CHART_TOOL,
  HOST_MEMORY_FORGET_TOOL,
  HOST_MEMORY_SAVE_TOOL,
  HOST_METRICS_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../chat.types';
import {
  builderChatAnalysisGuide,
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
    expect(guide).toContain('Recommend changes of seven kinds');
    expect(guide).toContain('view=team lists them under `userInstructions`');
    expect(guide).toContain('O-1, O-2… for overlay items');
    expect(guide).toContain('target "overlay"');
  });

  it('offers no overlay items for a plain chat', () => {
    const guide = threadAnalysisGuide('chat', null, true);

    expect(guide).not.toContain('target "overlay"');
    expect(guide).not.toContain('O-1');
  });

  it('points a team thread at view=spend for what the team cost, and a plain chat at none', () => {
    expect(threadAnalysisGuide('team', null, true)).toContain('view=spend');
    expect(threadAnalysisGuide('chat', null, true)).not.toContain('view=spend');
  });

  it("has a team thread assess each member as one run's thin sample, and a plain chat none", () => {
    const team = threadAnalysisGuide('team', null, true);
    const chat = threadAnalysisGuide('chat', null, true);

    expect(team).toContain('14. Member performance.');
    expect(team).toContain('15. Cluster by root cause');
    expect(team).toContain('One run is a thin sample');
    expect(team).toContain('and in `members` your assessment of each member');
    expect(chat).not.toContain('Member performance');
    expect(chat).not.toContain('`members`');
    expect(chat).toContain('14. Cluster by root cause');
  });

  it('tells both analyses a change the user asks for in words goes on its own card, to any team or project', () => {
    for (const guide of [
      threadAnalysisGuide('chat', null, true),
      threadAnalysisGuide('team', null, true),
      teamAnalysisGuide(null, true),
    ]) {
      const section = guide.slice(guide.indexOf('## Beyond the card'));
      expect(section).toContain('## Beyond the card');
      expect(section).toContain(HOST_PROPOSE_TEAM_TOOL);
      expect(section).toContain(HOST_PROJECT_INSTRUCTIONS_TOOL);
      expect(section).toContain('needs no Apply');
    }
  });

  it('offers knowledge items only while agents may write knowledge, moves first in and retires last', () => {
    for (const on of [
      threadAnalysisGuide('chat', null, true, true),
      threadAnalysisGuide('team', null, true, true),
      teamAnalysisGuide(null, true, true),
    ]) {
      expect(on).toContain('target "knowledge"');
      expect(on).toContain('K-1, K-2… for knowledge items');
      expect(on).toContain('What goes where:');
      expect(on).toContain('`movesWith`');
      const first = on.indexOf('First, knowledge items of kind add or update');
      const repo = on.indexOf('- Repo items:');
      const last = on.indexOf('Last, knowledge items of kind retire');
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(repo);
      expect(last).toBeGreaterThan(repo);
    }
    for (const off of [
      threadAnalysisGuide('chat', null, true),
      threadAnalysisGuide('team', null, true),
      teamAnalysisGuide(null, true),
    ]) {
      expect(off).not.toContain('target "knowledge"');
      expect(off).not.toContain('K-1');
      expect(off).not.toContain('kind retire');
    }
  });

  it('counts the kinds of change a team analysis recommends', () => {
    expect(teamAnalysisGuide(null, false)).toContain('changes of six kinds');
    expect(teamAnalysisGuide(null, true)).toContain('changes of seven kinds');
    expect(teamAnalysisGuide(null, true, true)).toContain(
      'changes of eight kinds',
    );
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

  it('reads a version diff by section="diff" in its History step, which pages by section and not by offset, and names view=spend', () => {
    const guide = teamAnalysisGuide(null, true);
    const history = guide.slice(
      guide.indexOf('1. History. Read view=history first'),
      guide.indexOf('2. Compare the runs. Read view=runs next'),
    );

    expect(history).toContain('section="diff" version=N');
    expect(history).not.toContain('next.offset` when it comes in chunks');
    expect(guide).toContain('view=spend');
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

  it("has the analyst mark every member's usefulness and quality, and name the items that carry out each verdict but keep", () => {
    for (const guide of [
      teamAnalysisGuide(null, true),
      builderChatAnalysisGuide(true, 10),
    ]) {
      expect(guide).toContain('9. Member performance.');
      expect(guide).toContain('Usefulness (1–5)');
      expect(guide).toContain('Quality (1–5)');
      expect(guide).toContain(
        'When the runs give too little to judge a mark, leave it null and say why in the summary — never guess a number',
      );
      for (const verdict of [
        'keep when',
        'tune when',
        'reconfigure when',
        'replace when',
        'remove when',
      ]) {
        expect(guide).toContain(verdict);
      }
      expect(guide).toContain(
        'Every verdict but keep names the items on this card that carry it out',
      );
      expect(guide).toContain(
        "a project's overlay beats the team, so a model it sets is changed there",
      );
      expect(guide).toContain('`members[].assessments`');
      expect(guide).toContain(
        'A mark the user disagreed with (`userVerdict.verdict` disagree) is a correction',
      );
      expect(guide).toContain(
        'a change measured worse is a case for undoing it',
      );
      expect(guide).toContain('view=history `members[].changes`');
      expect(guide).toContain(
        'one tuned twice with no gain is a case for replace or remove',
      );
      expect(guide).toContain(
        "Its `members` are every member's figures over every run",
      );
      expect(guide).not.toContain('One run is a thin sample');
    }
  });

  it("has the analyst measure every agent's instructions and grade them on five marks", () => {
    const guide = teamAnalysisGuide(null, true);

    expect(guide).toContain('10. Instruction size. Read view=team');
    expect(guide).toContain('`instructionSizes`');
    expect(guide).toContain('`inThisRun`');
    expect(guide).toContain('11. Instruction quality.');
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
      "Analyse the team \"Dev Team\" across its 5 latest runs: explain where its runs' time and money went and why, how useful each agent's work was and how well it held up, how large and how good each agent's instructions are, how its agents' models fit their work, and how the earlier changes to it worked out, and find what in the team or its environment would make the next runs faster, cheaper or less error-prone. Start with read_analyzed_thread view=history, then view=runs.",
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
      'changes of six kinds',
    );
  });

  it('offers project-instruction items everywhere, applied through their own save on the description-free instructions', () => {
    for (const guide of [
      threadAnalysisGuide('chat', null, false),
      threadAnalysisGuide('team', null, true),
      teamAnalysisGuide(null, true),
    ]) {
      expect(guide).toContain('target "project"');
      expect(guide).toContain('P-1, P-2');
      expect(guide).toContain('Read view=project');
      expect(guide).toContain(
        `- Last, project items: read view=project, then call \`${HOST_PROJECT_INSTRUCTIONS_TOOL}\``,
      );
      expect(guide).toContain("Never change the project's description");
      expect(
        guide.indexOf('for every selected item but the project items'),
      ).toBeGreaterThan(-1);
      expect(
        guide.indexOf('for every selected item but the project items'),
      ).toBeLessThan(guide.indexOf('- Last, project items:'));
      expect(guide).toContain(
        "end your turn at once; the verdict arrives as your next message — mark that project's items then",
      );
    }
    expect(builderChatAnalysisGuide(true, 5)).toContain(
      `- Last, project items not on that card: read view=project, then call \`${HOST_PROJECT_INSTRUCTIONS_TOOL}\``,
    );
    expect(builderChatAnalysisGuide(true, 5)).toContain(
      'but the project items and the items on the card, marked once its verdict arrives',
    );
  });
});

describe('reportRecommendationsInstructions', () => {
  it('names M- ids only while the shared memory is on', () => {
    expect(reportRecommendationsInstructions(true)).toContain('M-1, M-2');
    expect(reportRecommendationsInstructions(false)).not.toContain('M-1');
  });

  it('names P- ids for project instructions whatever the memory says', () => {
    for (const memory of [true, false]) {
      expect(reportRecommendationsInstructions(memory)).toContain(
        'P-1, P-2… for the instructions of the project',
      );
    }
  });
});

describe('analysis guides, the apply and the outcome', () => {
  const GUIDES = [
    threadAnalysisGuide('chat', null, false),
    threadAnalysisGuide('team', null, true),
    teamAnalysisGuide(null, false),
    builderChatAnalysisGuide(true, 5),
  ];

  it('offers target external to every analysis and says never to write in that repository', () => {
    for (const guide of GUIDES) {
      expect(guide).toContain('target "external"');
      expect(guide).toContain('never read or write files in that repository');
    }
  });

  it('has the apply file each external item as a task and mark it with the card key', () => {
    for (const guide of [
      threadAnalysisGuide('team', null, false),
      teamAnalysisGuide(null, false),
    ]) {
      expect(guide).toContain('Call `create_task` once per item');
      expect(guide).toContain(
        "Mark it applied with the card's key in the note",
      );
    }
  });

  it('tells a later analysis that an external item marked applied was filed, not done', () => {
    const guide = teamAnalysisGuide(null, false);

    expect(guide).toContain(
      'An external item marked applied had its card filed, not its work done',
    );
    expect(guide).toContain('`get_task` with the key in its note');
  });

  it('asks for one item, one decision in every analysis', () => {
    for (const guide of GUIDES) {
      expect(guide).toContain('One item, one decision:');
    }
  });

  it('no longer tells a team save to dry-run, since the save writes what the card approved', () => {
    for (const guide of [
      threadAnalysisGuide('team', null, false),
      teamAnalysisGuide(null, false),
    ]) {
      expect(guide).toContain(
        'save only your edits with `save_team_change` passing the hash you read',
      );
      expect(guide).not.toMatch(/dry[ -]?run/i);
      expect(guide).not.toContain('dryRun');
    }
  });

  it('puts a builder chat’s project items on its proposal card with recommendation_ids', () => {
    const guide = builderChatAnalysisGuide(true, 5);

    expect(guide).toContain(
      'project items of a project that runs this team by default',
    );
    expect(guide).toContain('with `recommendation_ids` naming each');
  });

  it('records no outcome before the card is recorded', () => {
    expect(teamAnalysisGuide(null, false)).toContain(
      'Record no outcome (`record_outcome`) before the receipt says the card is recorded',
    );
  });

  it('calls record_outcome once every selected item is marked, verdicts included', () => {
    for (const guide of [
      threadAnalysisGuide('team', null, false),
      teamAnalysisGuide(null, false),
    ]) {
      expect(guide).toContain(
        'Once every selected item is marked, verdicts included, call `record_outcome`',
      );
      expect(
        guide.indexOf('Once every selected item is marked'),
      ).toBeGreaterThan(guide.indexOf(`\`${HOST_RECOMMENDATION_MARKS_TOOL}\``));
    }
  });
});
