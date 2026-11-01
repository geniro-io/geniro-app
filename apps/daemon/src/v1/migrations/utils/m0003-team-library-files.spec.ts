import {
  chmodSync,
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

import { teamLibraryFiles } from './m0003-team-library-files';

describe('0003-team-library-files', () => {
  let userDataDir: string;
  const backup = (path: string): string => path;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'geniro-m0003-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const legacy = (...parts: string[]): string =>
    join(userDataDir, 'workflows', ...parts);
  const teams = (...parts: string[]): string =>
    join(userDataDir, 'teams', ...parts);

  function writeLegacyLibrary(): void {
    mkdirSync(legacy('.backups'), { recursive: true });
    mkdirSync(legacy('.claude'), { recursive: true });
    writeFileSync(legacy('dev-team.geniro.yaml'), 'name: Dev Team\n');
    writeFileSync(legacy('demo.geniro.yaml.bak'), 'name: Demo\n');
    writeFileSync(legacy('.workflow.schema.json'), '{}');
    writeFileSync(legacy('.claude', 'settings.json'), '{"a":1}');
    writeFileSync(
      legacy('.backups', 'dev-team.2026-10-31T10-00-00.yaml'),
      'name: Old\n',
    );
  }

  it('moves the library to teams/, renaming each *.geniro.yaml to *.team.yaml', async () => {
    writeLegacyLibrary();

    await teamLibraryFiles.up({ userDataDir, backup });

    expect(readFileSync(teams('dev-team.team.yaml'), 'utf8')).toBe(
      'name: Dev Team\n',
    );
    expect(readFileSync(teams('demo.geniro.yaml.bak'), 'utf8')).toBe(
      'name: Demo\n',
    );
    expect(
      readFileSync(
        teams('.backups', 'dev-team.2026-10-31T10-00-00.yaml'),
        'utf8',
      ),
    ).toBe('name: Old\n');
    expect(readFileSync(teams('.claude', 'settings.json'), 'utf8')).toBe(
      '{"a":1}',
    );
    expect(existsSync(teams('.workflow.schema.json'))).toBe(false);
    expect(existsSync(teams('dev-team.geniro.yaml'))).toBe(false);
  });

  it('keeps every original under workflows/.migrated/', async () => {
    writeLegacyLibrary();

    await teamLibraryFiles.up({ userDataDir, backup });

    expect(readdirSync(legacy())).toEqual(['.migrated']);
    expect(readdirSync(legacy('.migrated')).sort()).toEqual([
      '.backups',
      '.claude',
      '.workflow.schema.json',
      'demo.geniro.yaml.bak',
      'dev-team.geniro.yaml',
    ]);
    expect(
      readFileSync(legacy('.migrated', 'dev-team.geniro.yaml'), 'utf8'),
    ).toBe('name: Dev Team\n');
  });

  it('finishes a run that stopped part-way without overwriting what it already copied', async () => {
    writeLegacyLibrary();
    mkdirSync(teams(), { recursive: true });
    writeFileSync(teams('dev-team.team.yaml'), 'name: Edited since\n');

    await teamLibraryFiles.up({ userDataDir, backup });

    expect(readFileSync(teams('dev-team.team.yaml'), 'utf8')).toBe(
      'name: Edited since\n',
    );
    expect(existsSync(teams('demo.geniro.yaml.bak'))).toBe(true);
    expect(readdirSync(legacy())).toEqual(['.migrated']);
  });

  it('copies an entry again when only a part of it landed before the run stopped', async () => {
    writeLegacyLibrary();
    mkdirSync(teams('.backups.partial'), { recursive: true });
    writeFileSync(teams('.backups.partial', 'half.yaml'), 'cut');

    await teamLibraryFiles.up({ userDataDir, backup });

    expect(readdirSync(teams('.backups'))).toEqual([
      'dev-team.2026-10-31T10-00-00.yaml',
    ]);
    expect(existsSync(teams('.backups.partial'))).toBe(false);
  });

  it('fails rather than records the step done when it cannot tell whether a library exists', async () => {
    writeLegacyLibrary();
    chmodSync(userDataDir, 0o600);
    try {
      await expect(
        teamLibraryFiles.up({ userDataDir, backup }),
      ).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(userDataDir, 0o755);
    }
    expect(existsSync(teams('dev-team.team.yaml'))).toBe(false);
  });

  it('does nothing when run again', async () => {
    writeLegacyLibrary();
    await teamLibraryFiles.up({ userDataDir, backup });
    writeFileSync(teams('dev-team.team.yaml'), 'name: Edited since\n');

    await teamLibraryFiles.up({ userDataDir, backup });

    expect(readFileSync(teams('dev-team.team.yaml'), 'utf8')).toBe(
      'name: Edited since\n',
    );
  });

  it('creates nothing on a profile with no library', async () => {
    await teamLibraryFiles.up({ userDataDir, backup });

    expect(readdirSync(userDataDir)).toEqual([]);
  });

  it('down puts the originals back and sets teams/ aside', async () => {
    writeLegacyLibrary();
    await teamLibraryFiles.up({ userDataDir, backup });

    await teamLibraryFiles.down({ userDataDir, backup });

    expect(readFileSync(legacy('dev-team.geniro.yaml'), 'utf8')).toBe(
      'name: Dev Team\n',
    );
    expect(existsSync(legacy('.migrated'))).toBe(false);
    expect(existsSync(teams())).toBe(false);
    const aside = readdirSync(userDataDir).filter((name) =>
      name.startsWith('teams.rolled-back-'),
    );
    expect(aside).toHaveLength(1);
    expect(
      readFileSync(join(userDataDir, aside[0]!, 'dev-team.team.yaml'), 'utf8'),
    ).toBe('name: Dev Team\n');
  });
});
