import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCursorMcpServerEntry } from './cursor-mcp-entry';
import {
  backupPathOf,
  mergeGeniroEntry,
  restoreGeniroEntry,
} from './cursor-mcp-file';

const ENTRY = buildCursorMcpServerEntry({
  url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
  token: 'tok-secret',
});

const cwds: string[] = [];
afterEach(() => {
  for (const cwd of cwds.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function tempCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-mcp-file-spec-'));
  cwds.push(cwd);
  return cwd;
}

function configPath(cwd: string): string {
  return join(cwd, '.cursor', 'mcp.json');
}

function readConfig(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(cwd), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('mergeGeniroEntry / restoreGeniroEntry', () => {
  it('creates a 0600 file when none exists, and restore deletes it entirely', () => {
    const cwd = tempCwd();
    const result = mergeGeniroEntry(cwd, ENTRY);
    expect(result).toEqual({ ok: true, created: true });
    expect(readConfig(cwd)).toEqual({ mcpServers: { geniro: ENTRY } });
    expect(statSync(configPath(cwd)).mode & 0o777).toBe(0o600);
    expect(existsSync(backupPathOf(cwd))).toBe(false);

    restoreGeniroEntry(cwd, { created: true });
    expect(existsSync(configPath(cwd))).toBe(false);
  });

  it('merges into an existing file with a backup; restore removes ONLY the geniro key and keeps user edits made mid-turn', () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = {
      mcpServers: { userServer: { command: 'my-mcp' } },
      other: 'setting',
    };
    writeFileSync(configPath(cwd), JSON.stringify(original), 'utf8');

    const result = mergeGeniroEntry(cwd, ENTRY);
    expect(result).toMatchObject({ ok: true, created: false });
    // The original mode is recorded so restore can put it back.
    expect((result as { mode?: number }).mode).toBeTypeOf('number');
    expect(readConfig(cwd)).toEqual({
      mcpServers: { userServer: { command: 'my-mcp' }, geniro: ENTRY },
      other: 'setting',
    });
    expect(JSON.parse(readFileSync(backupPathOf(cwd), 'utf8'))).toEqual(
      original,
    );

    // The user edits the file WHILE the agent runs — those edits must survive.
    const midTurn = readConfig(cwd);
    (midTurn.mcpServers as Record<string, unknown>).addedMidTurn = {
      command: 'new',
    };
    writeFileSync(configPath(cwd), JSON.stringify(midTurn), 'utf8');

    restoreGeniroEntry(cwd, { created: false });
    expect(readConfig(cwd)).toEqual({
      mcpServers: {
        userServer: { command: 'my-mcp' },
        addedMidTurn: { command: 'new' },
      },
      other: 'setting',
    });
    expect(existsSync(backupPathOf(cwd))).toBe(false);
  });

  it('refuses an unparseable file without writing anything', () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(configPath(cwd), '{not json', 'utf8');

    const result = mergeGeniroEntry(cwd, ENTRY);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('not valid JSON');
    expect(readFileSync(configPath(cwd), 'utf8')).toBe('{not json');
    expect(existsSync(backupPathOf(cwd))).toBe(false);
  });

  it('refuses when a foreign geniro entry already occupies the key', () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = JSON.stringify({
      mcpServers: { geniro: { command: 'the-users-own' } },
    });
    writeFileSync(configPath(cwd), original, 'utf8');

    const result = mergeGeniroEntry(cwd, ENTRY);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('not ours');
    expect(readFileSync(configPath(cwd), 'utf8')).toBe(original);
  });

  it('byte-restores from the backup when the merged file no longer parses', () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = JSON.stringify({ mcpServers: { keep: { command: 'x' } } });
    writeFileSync(configPath(cwd), original, 'utf8');
    expect(mergeGeniroEntry(cwd, ENTRY)).toMatchObject({
      ok: true,
      created: false,
    });

    // Simulate a torn write during the turn.
    writeFileSync(configPath(cwd), '{torn', 'utf8');
    restoreGeniroEntry(cwd, { created: false });
    expect(readFileSync(configPath(cwd), 'utf8')).toBe(original);
    expect(existsSync(backupPathOf(cwd))).toBe(false);
  });

  it('restore of a geniro-created file must not delete a file the user REPLACED mid-turn with their own config', () => {
    const cwd = tempCwd();
    expect(mergeGeniroEntry(cwd, ENTRY)).toEqual({ ok: true, created: true });

    // The user replaced the created file with their own config while the
    // agent ran — from here on the file is user data, not ours to delete.
    const theirs = {
      mcpServers: { theirServer: { command: 'their-mcp' } },
    };
    writeFileSync(configPath(cwd), JSON.stringify(theirs), 'utf8');

    restoreGeniroEntry(cwd, { created: true });
    expect(existsSync(configPath(cwd))).toBe(true);
    expect(readConfig(cwd)).toEqual(theirs);
  });

  it('restore of a geniro-created file keeps server entries the user added mid-turn, removing only the geniro key', () => {
    const cwd = tempCwd();
    expect(mergeGeniroEntry(cwd, ENTRY)).toEqual({ ok: true, created: true });

    // The user added their own server to the created file while the agent
    // ran — deleting the whole file would destroy that entry.
    const midTurn = readConfig(cwd);
    (midTurn.mcpServers as Record<string, unknown>).addedMidTurn = {
      command: 'new',
    };
    writeFileSync(configPath(cwd), JSON.stringify(midTurn), 'utf8');

    restoreGeniroEntry(cwd, { created: true });
    expect(readConfig(cwd)).toEqual({
      mcpServers: { addedMidTurn: { command: 'new' } },
    });
  });

  it('a merge+restore round-trip never corrupts a parseable file whose mcpServers is not an object', () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    // Valid JSON, unexpected shape — spreading an array into an object turns
    // it into {"0": …} keys, a shape the surgical restore cannot undo.
    const original = { mcpServers: ['not', 'an', 'object'] };
    writeFileSync(configPath(cwd), JSON.stringify(original), 'utf8');

    const result = mergeGeniroEntry(cwd, ENTRY);
    if (result.ok) {
      restoreGeniroEntry(cwd, { created: result.created });
    }
    // Whatever merge decided (merge or refuse), the user's file must come out
    // of the round trip byte-meaning-identical: mcpServers stays an ARRAY.
    expect(readConfig(cwd)).toEqual(original);
  });

  it('drops the backup quietly when the user deleted the file mid-turn', () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(configPath(cwd), JSON.stringify({ mcpServers: {} }), 'utf8');
    expect(mergeGeniroEntry(cwd, ENTRY)).toMatchObject({
      ok: true,
      created: false,
    });

    rmSync(configPath(cwd), { force: true });
    restoreGeniroEntry(cwd, { created: false });
    expect(existsSync(configPath(cwd))).toBe(false);
    expect(existsSync(backupPathOf(cwd))).toBe(false);
  });
});
