import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTeamYamlDocument } from '../../teams/utils/team-yaml';
import {
  CONVERSION_NOTES_SUFFIX,
  TEAM_SHAPE_FILES_ID,
  teamShapeFiles,
} from './m0005-team-shape-files';
import { migrationBackups } from './migration-backups';

const LEGACY = `name: Two
nodes:
  - id: t
    kind: trigger
  - id: lead
    kind: agent
    agent: claude
    approval: ask
    description: coordinates
    role: be brief
  - id: helper
    kind: agent
    agent: codex
edges:
  - { from: t, to: lead, kind: data }
  - { from: lead, to: helper, kind: data }
  - { from: lead, to: helper, kind: call }
layout:
  lead: { x: 0, y: 0 }
`;

const TEAM = `# kept as written
name: Already
mode: lead
members:
  - id: a
    name: A
    agent: claude
    approval: auto
triggers:
  - { kind: first-message, member: a }
instructionBlocks: []
`;

describe('0005-team-shape-files', () => {
  let userDataDir: string;
  let teams: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'geniro-m0005-'));
    teams = join(userDataDir, 'teams');
    mkdirSync(teams);
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const up = async (at = new Date('2026-11-01T10:00:00Z')): Promise<void> => {
    const backups = migrationBackups(userDataDir, TEAM_SHAPE_FILES_ID, at);
    await teamShapeFiles.up({ userDataDir, backup: backups.backup });
  };
  const read = (name: string): string =>
    readFileSync(join(teams, name), 'utf8');
  const backupDir = (): string =>
    join(
      userDataDir,
      'backups',
      readdirSync(join(userDataDir, 'backups')).find((name) =>
        name.startsWith(TEAM_SHAPE_FILES_ID),
      )!,
      'teams',
    );

  it('rewrites a graph-shaped team in the team shape, backing the original up', async () => {
    writeFileSync(join(teams, 'two.team.yaml'), LEGACY);

    await up();

    const { team, legacyNotes } = parseTeamYamlDocument(read('two.team.yaml'));
    expect(legacyNotes).toBeNull();
    expect(team.members.map((m) => [m.id, m.role, m.instructions])).toEqual([
      ['lead', 'coordinates', 'be brief'],
      ['helper', undefined, undefined],
    ]);
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'lead' }]);
    expect(read('two.team.yaml')).not.toContain('layout');
    expect(readFileSync(join(backupDir(), 'two.team.yaml'), 'utf8')).toBe(
      LEGACY,
    );
  });

  it('writes what the conversion dropped beside the backup', async () => {
    writeFileSync(join(teams, 'two.team.yaml'), LEGACY);

    await up();

    expect(
      readFileSync(
        join(backupDir(), `two.team.yaml${CONVERSION_NOTES_SUFFIX}`),
        'utf8',
      ),
    ).toBe(
      'dropped the data edge "lead" → "helper": members hand work on by calling each other\n' +
        'every member may now call every other; the graph allowed only "lead" → "helper"\n',
    );
  });

  it('leaves a graph whose conversion the strict schema would refuse as it is, and backs nothing up', async () => {
    const long = LEGACY.replace(
      '    kind: agent\n    agent: codex',
      `    kind: agent\n    agent: codex\n    name: ${'x'.repeat(81)}`,
    );
    writeFileSync(join(teams, 'long.team.yaml'), long);

    await up();

    expect(read('long.team.yaml')).toBe(long);
    expect(existsSync(join(userDataDir, 'backups'))).toBe(false);
  });

  it('leaves a team-shaped file and an unparseable one as they are, and backs neither up', async () => {
    writeFileSync(join(teams, 'already.team.yaml'), TEAM);
    writeFileSync(join(teams, 'broken.team.yaml'), 'name: [unclosed');

    await up();

    expect(read('already.team.yaml')).toBe(TEAM);
    expect(read('broken.team.yaml')).toBe('name: [unclosed');
    expect(existsSync(join(userDataDir, 'backups'))).toBe(false);
  });

  it('does nothing on a second run or without a library', async () => {
    writeFileSync(join(teams, 'two.team.yaml'), LEGACY);
    await up();
    const converted = read('two.team.yaml');

    await up(new Date('2026-11-01T11:00:00Z'));

    expect(read('two.team.yaml')).toBe(converted);
    expect(
      readdirSync(join(userDataDir, 'backups')).filter((name) =>
        name.startsWith(TEAM_SHAPE_FILES_ID),
      ),
    ).toHaveLength(1);
    rmSync(teams, { recursive: true });
    await expect(up()).resolves.toBeUndefined();
  });

  it('down puts back every graph-shaped original, from each backup a crashed run left', async () => {
    writeFileSync(join(teams, 'two.team.yaml'), LEGACY);
    await up();
    const other = LEGACY.replace('name: Two', 'name: Other');
    writeFileSync(join(teams, 'other.team.yaml'), other);
    await up(new Date('2026-11-01T11:00:00Z'));

    await teamShapeFiles.down({ userDataDir, backup: () => '' });

    expect(read('two.team.yaml')).toBe(LEGACY);
    expect(read('other.team.yaml')).toBe(other);
  });
});
