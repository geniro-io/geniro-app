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

/** How the store keys its cache file: NUL-joined agent + cwd. */
const cacheKey = (cwd: string, agent = 'claude'): string =>
  `${agent}\u0000${cwd}`;

describe('SkillHarvestStore', () => {
  it('keeps each agent’s report separate in a folder both CLIs are used in', () => {
    // A folder is routinely used by both, and their invokable sets have
    // nothing to do with each other — claude's built-ins are not commands
    // cursor-agent can run.
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', ['compact', 'clear']);

    expect(store.get('cursor-agent', '/proj')).toBeNull();

    store.record('cursor-agent', '/proj', ['fix']);
    expect(store.get('cursor-agent', '/proj')).toEqual(['fix']);
    expect(store.get('claude', '/proj')).toEqual(['compact', 'clear']);
  });

  it('records and returns a per-agent, per-cwd list, cleaned of junk entries', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', [
      ' review ',
      'review',
      '',
      '__remote-workflow',
      'compact',
    ]);
    expect(store.get('claude', '/proj')).toEqual(['review', 'compact']);
    expect(store.get('claude', '/other')).toBeNull();
  });

  it('treats an effectively-empty report as a no-op, keeping the last harvest', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', ['deploy']);
    store.record('claude', '/proj', ['', '_internal']);
    expect(store.get('claude', '/proj')).toEqual(['deploy']);
  });

  it('persists across store instances via the cache file', () => {
    const file = cacheFile();
    new SkillHarvestStore({ file }).record('claude', '/proj', [
      'deploy',
      'review',
    ]);
    expect(new SkillHarvestStore({ file }).get('claude', '/proj')).toEqual([
      'deploy',
      'review',
    ]);
  });

  it('starts empty on a malformed cache file and can record over it', () => {
    const file = cacheFile();
    writeFileSync(file, 'not json{', 'utf8');
    const store = new SkillHarvestStore({ file });
    expect(store.get('claude', '/proj')).toBeNull();
    store.record('claude', '/proj', ['deploy']);
    expect(new SkillHarvestStore({ file }).get('claude', '/proj')).toEqual([
      'deploy',
    ]);
  });

  it('drops malformed records but keeps well-formed ones on load', () => {
    const file = cacheFile();
    writeFileSync(
      file,
      JSON.stringify({
        [cacheKey('/good')]: { commands: ['deploy'], harvestedAt: 1 },
        [cacheKey('/bad-shape')]: { commands: 'nope', harvestedAt: 1 },
        [cacheKey('/bad-entries')]: { commands: ['ok', 42], harvestedAt: 1 },
      }),
      'utf8',
    );
    const store = new SkillHarvestStore({ file });
    expect(store.get('claude', '/good')).toEqual(['deploy']);
    expect(store.get('claude', '/bad-shape')).toBeNull();
    expect(store.get('claude', '/bad-entries')).toBeNull();
  });
});
