import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillHarvestStore } from './skill-harvest.store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-harvest-'));
  dirs.push(dir);
  return join(dir, 'claude-skills.json');
}

describe('SkillHarvestStore', () => {
  it('records and returns a cwd-keyed list, cleaned of junk entries', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('/proj', [
      ' review ',
      'review',
      '',
      '__remote-workflow',
      'compact',
    ]);
    expect(store.get('/proj')).toEqual(['review', 'compact']);
    expect(store.get('/other')).toBeNull();
  });

  it('treats an effectively-empty report as a no-op, keeping the last harvest', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('/proj', ['deploy']);
    store.record('/proj', ['', '_internal']);
    expect(store.get('/proj')).toEqual(['deploy']);
  });

  it('persists across store instances via the cache file', () => {
    const file = cacheFile();
    new SkillHarvestStore({ file }).record('/proj', ['deploy', 'review']);
    expect(new SkillHarvestStore({ file }).get('/proj')).toEqual([
      'deploy',
      'review',
    ]);
  });

  it('starts empty on a malformed cache file and can record over it', () => {
    const file = cacheFile();
    writeFileSync(file, 'not json{', 'utf8');
    const store = new SkillHarvestStore({ file });
    expect(store.get('/proj')).toBeNull();
    store.record('/proj', ['deploy']);
    expect(new SkillHarvestStore({ file }).get('/proj')).toEqual(['deploy']);
  });

  it('drops malformed records but keeps well-formed ones on load', () => {
    const file = cacheFile();
    writeFileSync(
      file,
      JSON.stringify({
        '/good': { commands: ['deploy'], harvestedAt: 1 },
        '/bad-shape': { commands: 'nope', harvestedAt: 1 },
        '/bad-entries': { commands: ['ok', 42], harvestedAt: 1 },
      }),
      'utf8',
    );
    const store = new SkillHarvestStore({ file });
    expect(store.get('/good')).toEqual(['deploy']);
    expect(store.get('/bad-shape')).toBeNull();
    expect(store.get('/bad-entries')).toBeNull();
  });
});
