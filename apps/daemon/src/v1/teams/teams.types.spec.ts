import { describe, expect, it } from 'vitest';

import { TeamSchema } from './teams.types';

/**
 * The STRICT schema — the one the HTTP routes validate against
 * (`CreateTeamDto` / `SaveTeamDto`), the door the editor autosaves through.
 * `TeamYamlSchema` layers YAML leniency on top and is covered by
 * `utils/team-yaml.spec.ts`; a control character accepted here is written to
 * YAML and then makes every later read of that file throw.
 */
const worker = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'worker',
  name: 'Worker',
  agent: 'claude',
  approval: 'auto',
  ...over,
});

const teamWith = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'n',
  mode: 'lead',
  members: [worker()],
  triggers: [{ kind: 'first-message', member: 'worker' }],
  instructionBlocks: [],
  ...over,
});

const parse = (
  over: Record<string, unknown> = {},
): ReturnType<typeof TeamSchema.safeParse> =>
  TeamSchema.safeParse(teamWith(over));

describe('InstructionBlockSchema.text', () => {
  const parseText = (text: unknown): ReturnType<typeof TeamSchema.safeParse> =>
    parse({
      instructionBlocks: [
        { id: 'style', title: 'Style', text, audience: 'everyone' },
      ],
    });

  it('refuses a control character', () => {
    const result = parseText('a\u0000b');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      'control characters',
    );
  });

  it('accepts text of any length', () => {
    expect(parseText('x'.repeat(100_000)).success).toBe(true);
  });

  it('accepts the empty string a just-added block is saved with', () => {
    expect(parseText('').success).toBe(true);
  });

  it('requires the field on the wire', () => {
    expect(parseText(undefined).success).toBe(false);
  });

  it('takes everyone or a list of member ids as its audience, nothing else', () => {
    const withAudience = (audience: unknown): boolean =>
      parse({
        instructionBlocks: [{ id: 'b', title: 'B', text: 'x', audience }],
      }).success;

    expect(withAudience('everyone')).toBe(true);
    expect(withAudience(['worker'])).toBe(true);
    expect(withAudience('worker')).toBe(false);
    expect(withAudience([''])).toBe(false);
  });
});

/**
 * Every member string that reaches a spawned CLI. `instructions` and
 * `character` are claude's `--append-system-prompt` argv, `name`/`role`/`id`
 * are written into every other member's roster in that same argv,
 * `model`/`effort` are argv flags and `configDir` is the child's env — and
 * node throws at `spawn` on a NUL in any of them.
 */
describe('member text that reaches a CLI refuses a NUL', () => {
  const parseMember = (
    fields: Record<string, unknown>,
  ): ReturnType<typeof TeamSchema.safeParse> =>
    parse({ members: [worker(fields)] });

  it.each([
    'instructions',
    'role',
    'character',
    'name',
    'model',
    'effort',
    'contextWindow',
    'configDir',
  ])('refuses a NUL in `%s`', (field) => {
    const result = parseMember({ [field]: 'a\u0000b' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('NUL');
  });

  it('refuses a NUL in a member id', () => {
    expect(parseMember({ id: 'worker\u0000' }).success).toBe(false);
  });

  it('still reads instructions holding an ESC or a form-feed', () => {
    expect(
      parseMember({
        instructions: 'bold \u001b[1mtext\u001b[0m\u000cnext page',
      }).success,
    ).toBe(true);
  });

  it('still accepts tabs and line breaks in instructions and a role', () => {
    expect(
      parseMember({ instructions: 'line one\n\tline two\r\n', role: 'a\nb' })
        .success,
    ).toBe(true);
  });

  it('bounds the name and the character', () => {
    expect(parseMember({ name: 'x'.repeat(80) }).success).toBe(true);
    expect(parseMember({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(parseMember({ name: '' }).success).toBe(false);
    expect(parseMember({ character: 'x'.repeat(2000) }).success).toBe(true);
    expect(parseMember({ character: 'x'.repeat(2001) }).success).toBe(false);
  });
});

/**
 * `mcpDisabled` — the servers a member (or a pool member) runs WITHOUT. Each
 * name reaches a CLI as argv, a config key or a JSON file, so it refuses every
 * control character; the list and each name are bounded. TWIN:
 * `mcpServerNameProblem` / `MAX_MEMBER_MCP_DISABLED` in the renderer's
 * `teams/member-validate.ts`.
 */
describe('TeamMember.mcpDisabled', () => {
  const parseWith = (
    mcpDisabled: unknown,
    where: 'member' | 'pool' = 'member',
  ): ReturnType<typeof TeamSchema.safeParse> =>
    parse({
      members: [
        worker(
          where === 'member'
            ? { mcpDisabled }
            : { pool: [{ agent: 'codex', mcpDisabled }] },
        ),
      ],
    });

  it('accepts server names on a member and on a pool member', () => {
    expect(parseWith(['codegraph', 'claude.ai Gmail']).success).toBe(true);
    expect(parseWith(['playwright'], 'pool').success).toBe(true);
  });

  it.each(['member', 'pool'] as const)(
    'refuses an empty name or a control character on a %s',
    (where) => {
      expect(parseWith([''], where).success).toBe(false);
      const tabbed = parseWith(['code\tgraph'], where);
      expect(tabbed.success).toBe(false);
      expect(JSON.stringify(tabbed.error?.issues)).toContain(
        'control characters',
      );
      expect(parseWith(['a\u007fb'], where).success).toBe(false);
    },
  );

  it('bounds the list and each name', () => {
    expect(parseWith(['x'.repeat(256)]).success).toBe(true);
    expect(parseWith(['x'.repeat(257)]).success).toBe(false);
    const many = Array.from({ length: 100 }, (_, i) => `s${i}`);
    expect(parseWith(many).success).toBe(true);
    expect(parseWith([...many, 'one-more']).success).toBe(false);
  });
});

describe('Team.mode and Team.triggers', () => {
  it('takes lead or relay as the mode, and requires one', () => {
    expect(parse({ mode: 'lead' }).success).toBe(true);
    expect(parse({ mode: 'relay' }).success).toBe(true);
    expect(parse({ mode: 'graph' }).success).toBe(false);
    expect(parse({ mode: undefined }).success).toBe(false);
  });

  it('takes a first-message trigger naming a member, and no other kind', () => {
    expect(
      parse({ triggers: [{ kind: 'manual', member: 'worker' }] }).success,
    ).toBe(false);
    expect(
      parse({ triggers: [{ kind: 'first-message', member: '' }] }).success,
    ).toBe(false);
  });
});

describe('Team.maxActiveTurns', () => {
  const parseWith = (
    maxActiveTurns: unknown,
  ): ReturnType<typeof TeamSchema.safeParse> => parse({ maxActiveTurns });

  it('accepts a whole number of one or more, and its absence', () => {
    expect(parseWith(1).success).toBe(true);
    expect(parseWith(64).success).toBe(true);
    expect(parseWith(undefined).success).toBe(true);
  });

  it('refuses zero, a negative and a fraction', () => {
    expect(parseWith(0).success).toBe(false);
    expect(parseWith(-2).success).toBe(false);
    expect(parseWith(2.5).success).toBe(false);
  });
});

describe('Team.stages', () => {
  const stage = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: 'investigation',
    title: 'Investigation',
    goal: 'The cause is known',
    ...over,
  });
  const parseWith = (
    stages: unknown,
  ): ReturnType<typeof TeamSchema.safeParse> => parse({ stages });

  it('accepts a stage list, and its absence', () => {
    expect(
      parseWith([
        stage({ next: ['fix', 'implementation'], responsible: ['worker'] }),
        stage({ id: 'fix', title: 'Fix', howToWork: 'Patch it.' }),
        stage({ id: 'implementation', title: 'Implementation' }),
      ]).success,
    ).toBe(true);
    expect(parseWith(undefined).success).toBe(true);
  });

  it('refuses an id that is all digits, upper-case or too long', () => {
    expect(parseWith([stage({ id: '42' })]).success).toBe(false);
    expect(parseWith([stage({ id: 'Review' })]).success).toBe(false);
    expect(parseWith([stage({ id: 'a'.repeat(41) })]).success).toBe(false);
    expect(parseWith([stage({ id: 'step-2' })]).success).toBe(true);
  });

  it('refuses a blank title or goal and an over-long field', () => {
    expect(parseWith([stage({ title: '   ' })]).success).toBe(false);
    expect(parseWith([stage({ goal: '' })]).success).toBe(false);
    expect(parseWith([stage({ title: 'x'.repeat(81) })]).success).toBe(false);
    expect(parseWith([stage({ howToWork: 'x'.repeat(4001) })]).success).toBe(
      false,
    );
  });

  it('refuses a NUL in any stage text that reaches an agent', () => {
    for (const over of [
      { title: 'a\u0000b' },
      { howToWork: 'a\u0000b' },
      { goal: 'a\u0000b' },
      { responsible: ['a\u0000b'] },
    ]) {
      expect(parseWith([stage(over)]).success).toBe(false);
    }
  });

  it('describes the stage walk without a terminal "done" stage', () => {
    const description = TeamSchema.shape.stages.description ?? '';
    expect(description).toContain('investigation');
    expect(description).not.toMatch(/→\s*done\b/);
  });
});
