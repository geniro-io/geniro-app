import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readClaudeConfigDirPin } from './claude-config-dir.utils';

describe('readClaudeConfigDirPin', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'geniro-pin-'));
    mkdirSync(join(cwd, '.claude'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const write = (file: string, body: unknown): void =>
    writeFileSync(join(cwd, '.claude', file), JSON.stringify(body));

  it('finds the config directory a folder PINS through its settings env block', () => {
    write('settings.local.json', {
      env: { CLAUDE_CONFIG_DIR: '/profiles/team', TURBO_CONCURRENCY: '12' },
    });

    expect(readClaudeConfigDirPin(cwd)).toEqual({
      effective: '/profiles/team',
      source: join(cwd, '.claude', 'settings.local.json'),
    });
  });

  it('lets settings.local.json override settings.json, which is the CLI’s own precedence', () => {
    write('settings.json', { env: { CLAUDE_CONFIG_DIR: '/profiles/shared' } });
    write('settings.local.json', {
      env: { CLAUDE_CONFIG_DIR: '/profiles/mine' },
    });

    expect(readClaudeConfigDirPin(cwd)?.effective).toBe('/profiles/mine');
  });

  it('reads the shared file when only it pins one', () => {
    write('settings.json', { env: { CLAUDE_CONFIG_DIR: '/profiles/shared' } });

    expect(readClaudeConfigDirPin(cwd)?.effective).toBe('/profiles/shared');
  });

  it('answers null for a folder whose settings say nothing about the profile', () => {
    write('settings.json', {
      permissions: {},
      env: { TURBO_CONCURRENCY: '12' },
    });

    expect(readClaudeConfigDirPin(cwd)).toBeNull();
  });

  it('answers null for a folder with no settings at all', () => {
    expect(readClaudeConfigDirPin(cwd)).toBeNull();
  });

  it('answers null rather than throwing on a settings file that is not JSON', () => {
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json');

    expect(readClaudeConfigDirPin(cwd)).toBeNull();
  });

  it('does not treat a blank value as a pin — there is nothing to name', () => {
    write('settings.local.json', { env: { CLAUDE_CONFIG_DIR: '   ' } });

    expect(readClaudeConfigDirPin(cwd)).toBeNull();
  });
});
