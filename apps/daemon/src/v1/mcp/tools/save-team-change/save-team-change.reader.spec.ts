import { describe, expect, it } from 'vitest';

import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { ThreadReaderService } from '../../../agents/services/thread-reader.service';
import type {
  TeamChange,
  TeamChangeService,
} from '../../../teams/services/team-change.service';
import type { McpCallContext } from '../../mcp.types';
import {
  readSaveTeamChangeArgs,
  teamChangeResultText,
} from './save-team-change.reader';
import { SaveTeamChangeTool } from './save-team-change.tool';

const CONTEXT = {
  runId: 'analysis',
  memberId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

const BUILDER_CONTEXT = { ...CONTEXT, runId: 'builder' } as McpCallContext;

/**
 * The tool over doubles. `answers` are what successive saves answer, in turn;
 * past the last one every save answers `{saved: true}`.
 */
function tool(slug: string | null, answers: Record<string, unknown>[] = []) {
  const saved: TeamChange[] = [];
  const analysis = new AnalysisBroker();
  const builders = new TeamBuilderBroker();
  builders.register('builder', 'agent', {
    slug: 'team',
    turnStartedAt: 5,
    savedHash: null,
    acceptsAnyVersion: false,
  });
  analysis.register('analysis', 'agent', {
    turn: {
      analysisRunId: 'analysis',
      sourceRunId: 'source',
      snapshotSeq: 9,
      sourceWorking: false,
    },
    report: () => Promise.reject(new Error('unused')),
    mark: () => Promise.reject(new Error('unused')),
  });
  return {
    saved,
    save: new SaveTeamChangeTool(
      analysis,
      builders,
      {
        analysedTeamOf: () =>
          Promise.resolve(slug === null ? null : { slug, snapshot: null }),
      } as unknown as ThreadReaderService,
      {
        save: (change: TeamChange) => {
          saved.push(change);
          return Promise.resolve(
            answers.shift() ?? { saved: true, backup: '.backups/x.yaml' },
          );
        },
      } as unknown as TeamChangeService,
    ),
  };
}

describe('SaveTeamChangeTool', () => {
  it("saves the analysed thread's own team, on behalf of this analysis", async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_team_change',
      {
        edits: [{ find: 'old', replace: 'new' }],
        baseHash: 'abc',
        ids: ['W-1'],
      },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(saved).toEqual([
      {
        authority: {
          kind: 'apply',
          analysisRunId: 'analysis',
          ids: ['W-1'],
          baseHash: 'abc',
        },
        slug: 'dev-team',
        edits: [{ find: 'old', replace: 'new' }],
        dryRun: false,
      },
    ]);
  });

  it("only checks a builder chat's own team, named by the chat and never by the model", async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_team_change',
      { edits: [{ path: 'name', value: 'x' }] },
      BUILDER_CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(saved).toEqual([
      {
        authority: {
          kind: 'builder',
          savedHash: null,
          turnStartedAt: 5,
          acceptsAnyVersion: false,
        },
        slug: 'team',
        edits: [{ path: 'name', value: 'x' }],
        dryRun: true,
      },
    ]);
  });

  it("refuses a builder chat's dryRun: its change is saved behind the proposal card", async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_team_change',
      { edits: [{ path: 'name', value: 'x' }], dryRun: false },
      BUILDER_CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^INVALID_ARGS/);
    expect(saved).toEqual([]);
  });

  it('holds each later check of the turn to the version the last one read or found', async () => {
    const { save, saved } = tool('dev-team', [
      { dryRun: true, saved: false, currentHash: 'read' },
      { saved: false, error: 'HASH_DRIFT', currentHash: 'found' },
    ]);
    const call = () =>
      save.call(
        'save_team_change',
        { edits: [{ path: 'name', value: 'x' }] },
        BUILDER_CONTEXT,
      );

    await call();
    await call();
    await call();

    expect(saved.map((change) => change.authority)).toEqual([
      {
        kind: 'builder',
        savedHash: null,
        turnStartedAt: 5,
        acceptsAnyVersion: false,
      },
      {
        kind: 'builder',
        savedHash: 'read',
        turnStartedAt: 5,
        acceptsAnyVersion: false,
      },
      {
        kind: 'builder',
        savedHash: 'found',
        turnStartedAt: 5,
        acceptsAnyVersion: false,
      },
    ]);
  });

  it('never notes a version into the turn after the one a late check belongs to', async () => {
    const builders = new TeamBuilderBroker();
    builders.register('builder', 'agent', {
      slug: 'team',
      turnStartedAt: 5,
      savedHash: null,
      acceptsAnyVersion: false,
    });
    const save = new SaveTeamChangeTool(
      new AnalysisBroker(),
      builders,
      {} as ThreadReaderService,
      {
        // The user stops the turn and sends again while this check is out.
        save: () => {
          builders.register('builder', 'agent', {
            slug: 'team',
            turnStartedAt: 9,
            savedHash: null,
            acceptsAnyVersion: false,
          });
          return Promise.resolve({
            dryRun: true,
            saved: false,
            currentHash: 'late',
          });
        },
      } as unknown as TeamChangeService,
    );

    await save.call(
      'save_team_change',
      { edits: [{ path: 'name', value: 'x' }] },
      BUILDER_CONTEXT,
    );

    await expect(builders.teamOf('builder', 'agent')).resolves.toEqual({
      slug: 'team',
      turnStartedAt: 9,
      savedHash: null,
      acceptsAnyVersion: false,
    });
  });

  it('lets the next check take the repaired file after a refusal for a file it could not load', async () => {
    const { save, saved } = tool('dev-team', [
      { saved: false, error: 'TEAM_UNREADABLE', message: 'x' },
      { dryRun: true, saved: false, currentHash: 'repaired' },
    ]);
    const call = () =>
      save.call(
        'save_team_change',
        { edits: [{ path: 'name', value: 'x' }] },
        BUILDER_CONTEXT,
      );

    await call();
    await call();
    await call();

    expect(
      saved.map(({ authority }) =>
        authority.kind === 'builder'
          ? [authority.savedHash, authority.acceptsAnyVersion]
          : null,
      ),
    ).toEqual([
      [null, false],
      [null, true],
      ['repaired', false],
    ]);
  });

  it('refuses recommendation ids and a hash from a builder chat', async () => {
    const { save, saved } = tool('dev-team');
    const refused = async (extra: Record<string, unknown>) =>
      (
        await save.call(
          'save_team_change',
          { edits: [{ path: 'name', value: 'x' }], ...extra },
          BUILDER_CONTEXT,
        )
      ).content[0]!.text;

    expect(await refused({ ids: ['W-1'] })).toMatch(/^INVALID_ARGS:/);
    expect(await refused({ baseHash: 'abc' })).toMatch(/^INVALID_ARGS:/);
    expect(saved).toEqual([]);
  });

  it('refuses a call from a turn that may change no team', async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_team_change',
      { edits: [{ path: 'name', value: 'x' }] },
      { ...CONTEXT, runId: 'plain' } as McpCallContext,
    );

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Nothing saved: no turn is running that may change a team.',
        },
      ],
      isError: true,
    });
    expect(saved).toEqual([]);
  });

  it('lists the builder wording and asks no ids of a builder chat only', () => {
    const { save } = tool('dev-team');

    const [builder] = save.list(BUILDER_CONTEXT);
    const [analysis] = save.list(CONTEXT);

    expect(builder!.description).toMatch(/the team this chat edits/);
    expect(builder!.inputSchema).not.toHaveProperty('properties.ids');
    expect(builder!.inputSchema).not.toHaveProperty('properties.baseHash');
    expect(analysis!.description).toMatch(/the analysed thread's team/);
    expect(analysis!.inputSchema).toHaveProperty(
      'required',
      expect.arrayContaining(['ids']),
    );
    expect(save.list({ ...CONTEXT, runId: 'plain' })).toEqual([]);
  });

  it('refuses for a plain chat analysis without touching the library', async () => {
    const { save, saved } = tool(null);

    const result = await save.call(
      'save_team_change',
      { edits: [{ path: 'name', value: 'x' }], baseHash: 'abc', ids: ['W-1'] },
      CONTEXT,
    );

    expect(result.content[0]!.text).toContain('NOT_A_TEAM');
    expect(saved).toEqual([]);
  });
});

describe('readSaveTeamChangeArgs', () => {
  it('refuses a call naming no recommendation, a malformed id, or a repo id', () => {
    const ids = (value: string[]) =>
      readSaveTeamChangeArgs({
        edits: [{ path: 'name', value: 'x' }],
        baseHash: 'a',
        ids: value,
      }).ok;

    expect(ids([])).toBe(false);
    expect(ids(['x'])).toBe(false);
    expect(ids(['R-1'])).toBe(false);
    expect(ids(['W-1'])).toBe(true);
  });
});

describe('readSaveTeamChangeArgs edits', () => {
  const edits = (value: unknown) =>
    readSaveTeamChangeArgs({ edits: value, baseHash: 'a', ids: ['W-1'] }).ok;

  it('reads each edit shape', () => {
    expect(edits([{ find: 'a', replace: 'b' }])).toBe(true);
    expect(edits([{ path: 'members/x/model', value: 'sonnet' }])).toBe(true);
    expect(edits([{ path: 'members/x/model', remove: true }])).toBe(true);
  });

  it('refuses the whole team, no edits, an empty find, and a mixed edit', () => {
    expect(
      readSaveTeamChangeArgs({
        team: { name: 'Dev Team' },
        baseHash: 'a',
        ids: ['W-1'],
      }).ok,
    ).toBe(false);
    expect(edits([])).toBe(false);
    expect(edits([{ find: '', replace: 'b' }])).toBe(false);
    expect(edits([{ find: 'a', replace: 'b', path: 'name' }])).toBe(false);
  });
});

describe('teamChangeResultText', () => {
  it('flags a refusal as an error', () => {
    expect(
      teamChangeResultText({ saved: false, error: 'HASH_DRIFT' }).isError,
    ).toBe(true);
    expect(teamChangeResultText({ saved: true }).isError).toBe(false);
  });
});
