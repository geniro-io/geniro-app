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
const cacheKey = (
  cwd: string,
  agent = 'claude',
  configDir: string | null = null,
): string => `${agent}\u0000${cwd}\u0000${configDir ?? ''}`;

/** A reported command with no sentence — claude's whole report shape. */
const named = (name: string): { name: string; description: null } => ({
  name,
  description: null,
});

describe('SkillHarvestStore', () => {
  it('keeps each agent’s report separate in a folder both CLIs are used in', () => {
    // A folder is routinely used by both, and their invokable sets have
    // nothing to do with each other — claude's built-ins are not commands
    // cursor-agent can run.
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', null, [named('compact'), named('clear')]);

    expect(store.get('cursor-agent', '/proj', null)).toBeNull();

    store.record('cursor-agent', '/proj', null, [named('fix')]);
    expect(store.get('cursor-agent', '/proj', null)).toEqual([named('fix')]);
    expect(store.get('claude', '/proj', null)).toEqual([
      named('compact'),
      named('clear'),
    ]);
  });

  it('records and returns a per-agent, per-cwd list, cleaned of junk entries', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', null, [
      named(' review '),
      named('review'),
      named(''),
      named('__remote-workflow'),
      named('compact'),
    ]);
    expect(store.get('claude', '/proj', null)).toEqual([
      named('review'),
      named('compact'),
    ]);
    expect(store.get('claude', '/other', null)).toBeNull();
  });

  it('keeps the DESCRIPTION a CLI reported, blank ones normalized to null', () => {
    // The sentence is the whole point of the pair: for a CLI whose invokable
    // set geniro cannot scan off disk, this report is the only source of it,
    // and the composer's popup renders a row without one as a bare word.
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('cursor-agent', '/proj', null, [
      { name: ' shell ', description: '  Run the rest as a shell command  ' },
      { name: 'sdk', description: '   ' },
    ]);
    expect(store.get('cursor-agent', '/proj', null)).toEqual([
      { name: 'shell', description: 'Run the rest as a shell command' },
      { name: 'sdk', description: null },
    ]);
  });

  it('treats an effectively-empty report as a no-op, keeping the last harvest', () => {
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', null, [named('deploy')]);
    store.record('claude', '/proj', null, [named(''), named('_internal')]);
    expect(store.get('claude', '/proj', null)).toEqual([named('deploy')]);
  });

  it('persists across store instances via the cache file', () => {
    const file = cacheFile();
    new SkillHarvestStore({ file }).record('cursor-agent', '/proj', null, [
      { name: 'deploy', description: 'Ship the thing' },
      named('review'),
    ]);
    // The description survives the round trip too — it is what the popup
    // shows, and a cache that dropped it would silently undo the fix on the
    // next daemon restart.
    expect(
      new SkillHarvestStore({ file }).get('cursor-agent', '/proj', null),
    ).toEqual([
      { name: 'deploy', description: 'Ship the thing' },
      named('review'),
    ]);
  });

  it('starts empty on a malformed cache file and can record over it', () => {
    const file = cacheFile();
    writeFileSync(file, 'not json{', 'utf8');
    const store = new SkillHarvestStore({ file });
    expect(store.get('claude', '/proj', null)).toBeNull();
    store.record('claude', '/proj', null, [named('deploy')]);
    expect(
      new SkillHarvestStore({ file }).get('claude', '/proj', null),
    ).toEqual([named('deploy')]);
  });

  it('drops malformed records but keeps well-formed ones on load', () => {
    const file = cacheFile();
    // `entries`, not `commands`: the on-disk field is named by the shared
    // HarvestStore, which now backs the MCP harvest too. A deliberate break of
    // the old file — the cache is a nicety that the next turn re-harvests, so
    // an existing one is simply ignored rather than migrated.
    //
    // `/name-only` is the shape this store wrote before entries carried a
    // description, and it is dropped by the same rule for the same reason: no
    // migration, the next turn in that folder re-harvests with sentences.
    writeFileSync(
      file,
      JSON.stringify({
        [cacheKey('/good')]: {
          entries: [{ name: 'deploy', description: 'Ship it' }],
          harvestedAt: 1,
        },
        [cacheKey('/bad-shape')]: { entries: 'nope', harvestedAt: 1 },
        [cacheKey('/bad-entries')]: {
          entries: [{ name: 'ok', description: null }, 42],
          harvestedAt: 1,
        },
        [cacheKey('/name-only')]: { entries: ['deploy'], harvestedAt: 1 },
      }),
      'utf8',
    );
    const store = new SkillHarvestStore({ file });
    expect(store.get('claude', '/good', null)).toEqual([
      { name: 'deploy', description: 'Ship it' },
    ]);
    expect(store.get('claude', '/bad-shape', null)).toBeNull();
    expect(store.get('claude', '/bad-entries', null)).toBeNull();
    expect(store.get('claude', '/name-only', null)).toBeNull();
  });
});

describe('SkillHarvestStore — one report per ACCOUNT', () => {
  it("keeps two profiles' reports apart in one folder", () => {
    // A CLI answers for the plugins installed in the config directory it runs
    // under — measured, `~/.claude` holds 10 of them against each profile's own
    // 7 — so one folder used by two accounts has two invokable sets. Without
    // the profile in the key the first turn to report filed its set as the
    // folder's, and every chat there was offered it.
    const store = new SkillHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', '/profiles/team', [named('/team-only')]);
    store.record('claude', '/proj', '/profiles/max', [named('/max-only')]);

    expect(store.get('claude', '/proj', '/profiles/team')).toEqual([
      named('/team-only'),
    ]);
    expect(store.get('claude', '/proj', '/profiles/max')).toEqual([
      named('/max-only'),
    ]);
    expect(store.get('claude', '/proj', null)).toBeNull();
  });
});
