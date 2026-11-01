import { describe, expect, it } from 'vitest';

import {
  BUILDER_CHAT_ANALYSED_RUNS,
  HOST_ANALYZED_THREAD_TOOL,
  HOST_BACKUP_TEAM_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../../agents/chat.types';
import {
  ApprovalModeSchema,
  EDGE_KINDS,
  NODE_CONNECTION_RULES,
  NODE_KINDS,
} from '../teams.types';
import { composeTeamChatInstructions } from './team-chat-instructions';

const LIBRARY = '/Users/x/Library/Application Support/Geniro/teams';

const BRIEF = composeTeamChatInstructions({
  path: `${LIBRARY}/dev-team.team.yaml`,
  slug: 'dev-team',
  name: 'Dev Team',
  schemaPath: `${LIBRARY}/.team.schema.json`,
  memory: true,
  inLibrary: true,
});

describe('composeTeamChatInstructions', () => {
  it('names the one file this chat edits, in full', () => {
    expect(BRIEF).toContain(`${LIBRARY}/dev-team.team.yaml`);
  });

  it('names the team the way the user sees it in the builder', () => {
    expect(BRIEF).toContain('"Dev Team"');
  });

  // The structure reference is the whole defence against a field list that
  // drifts from the validator, so the brief must actually hand it over.
  it('points at the generated schema for the structure', () => {
    expect(BRIEF).toContain(`${LIBRARY}/.team.schema.json`);
  });

  it('names the slug the team tools know it by', () => {
    expect(BRIEF).toContain('slug `dev-team`');
  });

  it('tells the agent to propose every change on a card, never write it or only describe it', () => {
    expect(BRIEF).toMatch(
      new RegExp(
        `Make every change by proposing it with ${HOST_PROPOSE_TEAM_TOOL}, never\\s+by writing the file yourself`,
      ),
    );
    expect(BRIEF).toMatch(/An edit you\s+only\s+describe\s+never\s+happens/);
  });

  it('has the card say what changes and why, and the turn end on it', () => {
    expect(BRIEF).toMatch(
      /a one-line `summary` of what\s+they change and a `reason` saying why/,
    );
    expect(BRIEF).toMatch(/only when they approve/);
    expect(BRIEF).toMatch(/END YOUR TURN/);
  });

  it('offers save_team_change as a check that saves nothing', () => {
    expect(BRIEF).toMatch(
      new RegExp(
        `${HOST_TEAM_CHANGE_TOOL} checks a set of edits against the file and\\s+answers the diff without saving`,
      ),
    );
  });

  it('tells the agent to read the WHOLE file before changing it', () => {
    expect(BRIEF).toMatch(
      /Read the whole team file with your own file tools before your first\s+change of each turn/,
    );
  });

  it('lets the agent write the file itself only to repair YAML refused as unreadable', () => {
    expect(BRIEF).toMatch(
      /when a proposal or a check\s+answers TEAM_UNREADABLE/,
    );
    expect(BRIEF).toMatch(/Fix only what that\s+refusal names/);
  });

  it('backs the file up through backup_team when the user asks', () => {
    expect(BRIEF).toMatch(
      new RegExp(
        `Back the file up with ${HOST_BACKUP_TEAM_TOOL} whenever the user asks`,
      ),
    );
  });

  it('builds a new team on one card too, never by writing the document', () => {
    expect(BRIEF).toMatch(
      new RegExp(
        `propose every part of it on one ${HOST_PROPOSE_TEAM_TOOL} card`,
      ),
    );
    expect(BRIEF).not.toMatch(/write the whole document/);
  });

  // Each meaning is a `Record` over its enum, so a new member fails the build;
  // these pin that the rendered brief carries every one of them.
  it('explains every node kind the schema accepts', () => {
    for (const kind of NODE_KINDS) {
      expect(BRIEF).toMatch(new RegExp(`^- ${kind}: \\S`, 'm'));
    }
  });

  it('explains every edge kind the schema accepts', () => {
    for (const kind of EDGE_KINDS) {
      expect(BRIEF).toMatch(new RegExp(`^- ${kind}: \\S`, 'm'));
    }
  });

  it('explains every approval mode the schema accepts', () => {
    for (const mode of ApprovalModeSchema.options) {
      expect(BRIEF).toMatch(new RegExp(`^- ${mode}: \\S`, 'm'));
    }
  });

  // Read off NODE_CONNECTION_RULES rather than typed out, so a rule added
  // there reaches the brief with no edit to it.
  it('lists exactly the connections NODE_CONNECTION_RULES allows', () => {
    const listed = [...BRIEF.matchAll(/^- (\w+) → (\w+) \(`(\w+)`\)/gm)]
      .map(([, from, to, edge]) => `${from}->${to}:${edge}`)
      .sort();
    const allowed = NODE_KINDS.flatMap((from) =>
      NODE_CONNECTION_RULES[from].outputs
        .filter((out) =>
          NODE_CONNECTION_RULES[out.kind].inputs.some(
            (rule) => rule.edge === out.edge && rule.kind === from,
          ),
        )
        .map((out) => `${from}->${out.kind}:${out.edge}`),
    ).sort();
    expect(listed).toEqual(allowed);
  });

  it('states the arity limits of a single-edge rule', () => {
    // A trigger feeds one agent, and an agent takes one trigger.
    expect(BRIEF).toContain(
      '- trigger → agent (`data`): each trigger node has only one; each agent node takes only one',
    );
  });

  it('holds the text inside the team to the instruction-writing rules', () => {
    expect(BRIEF).toMatch(/One home per fact/);
    expect(BRIEF).toMatch(/Keep a sentence only if removing it would change/);
  });

  it('routes every change through the team tools, never the agent writing the file', () => {
    expect(BRIEF).toContain(HOST_PROPOSE_TEAM_TOOL);
    expect(BRIEF).toContain(HOST_TEAM_CHANGE_TOOL);
    expect(BRIEF).toContain(HOST_READ_TEAMS_TOOL);
    expect(BRIEF).not.toMatch(/editing the file with your own file tools/);
  });

  it('tells the builder the stage walk ends at the last stage, so no closing "Done" stage is added', () => {
    expect(BRIEF).toMatch(
      /the walk ends when the last stage is completed, so add no closing "Done" or\s+"Finished" stage/,
    );
  });

  it("carries the team analysis's method over the team's newest runs", () => {
    expect(BRIEF).toContain('<team-analysis>');
    expect(BRIEF).toContain(
      `You read its ${BUILDER_CHAT_ANALYSED_RUNS} newest runs through \`${HOST_ANALYZED_THREAD_TOOL}\``,
    );
    expect(BRIEF).toMatch(/Read view=history first/);
    expect(BRIEF).toMatch(/Read view=runs next/);
    expect(BRIEF).toContain(`call \`${HOST_RECOMMENDATIONS_TOOL}\` ONCE`);
  });

  it('applies a selected team item on a proposal card, never a save', () => {
    const analysis = BRIEF.slice(BRIEF.indexOf('<team-analysis>'));
    expect(analysis).toContain(
      `- Team items: put every selected team item on ONE \`${HOST_PROPOSE_TEAM_TOOL}\` card`,
    );
    expect(analysis).not.toContain(HOST_TEAM_CHANGE_TOOL);
  });

  it("points repo items at the runs' own repository, not the library it works in", () => {
    const analysis = BRIEF.slice(BRIEF.indexOf('<team-analysis>'));
    expect(analysis).toContain(
      "edit the files in the repository the runs worked in (each run's `cwd` in view=overview)",
    );
    expect(analysis).not.toContain('working folder');
  });

  it('names the memory target only while the shared memory is on', () => {
    const off = composeTeamChatInstructions({
      path: `${LIBRARY}/dev-team.team.yaml`,
      slug: 'dev-team',
      name: 'Dev Team',
      schemaPath: `${LIBRARY}/.team.schema.json`,
      memory: false,
      inLibrary: true,
    });
    expect(BRIEF).toContain('target "memory"');
    expect(off).not.toContain('target "memory"');
  });
});
