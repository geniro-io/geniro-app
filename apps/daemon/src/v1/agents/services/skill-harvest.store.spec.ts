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
  it('records and returns an (agent, cwd)-keyed list, cleaned of junk entries', () => {
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
        '/good': { commands: ['deploy'], harvestedAt: 1 },
        '/bad-shape': { commands: 'nope', harvestedAt: 1 },
        '/bad-entries': { commands: ['ok', 42], harvestedAt: 1 },
      }),
      'utf8',
    );
    const store = new SkillHarvestStore({ file });
    expect(store.get('claude', '/good')).toEqual(['deploy']);
    expect(store.get('claude', '/bad-shape')).toBeNull();
    expect(store.get('claude', '/bad-entries')).toBeNull();
  });

  it('keeps each agent’s harvest separate for one shared folder', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', ['compact']);
    store.record('cursor-agent', '/proj', ['generate-cursor-rules']);

    // A command one CLI reports is not invokable in the other, so neither
    // listing may leak into the other's `/` autocomplete.
    expect(store.get('claude', '/proj')).toEqual(['compact']);
    expect(store.get('cursor-agent', '/proj')).toEqual([
      'generate-cursor-rules',
    ]);
  });

  it('adopts a legacy cwd-keyed cache as claude’s rather than dropping it', () => {
    const file = cacheFile();
    // How every cache written before the agent dimension existed looks. Only
    // claude ever populated one — the legacy cursor transport reported no
    // commands — so these entries are claude's, and an upgrade must keep them.
    writeFileSync(
      file,
      JSON.stringify({ '/proj': { commands: ['compact'], harvestedAt: 1 } }),
      'utf8',
    );
    const store = new SkillHarvestStore({ file });
    expect(store.get('claude', '/proj')).toEqual(['compact']);
    expect(store.get('cursor-agent', '/proj')).toBeNull();
  });
});
