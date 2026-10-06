import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findClaudeSessionFileSync,
  readLastClaudeCostState,
} from './claude-cost-state.utils';

const SESSION = '95eb2ed0-f2c6-4d0e-a62a-d20905a58d10';

/** A `cost-state` line as claude 2.1.284 writes it at a graceful exit. */
function costState(total: number, sessionId = SESSION): string {
  return JSON.stringify({
    type: 'cost-state',
    sessionId,
    totalCostUSD: total,
    totalAPIDuration: 2254,
  });
}

function sessionFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-cost-state-'));
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

describe('readLastClaudeCostState', () => {
  it('answers the LAST cost-state, which is what a resume restores', () => {
    const path = sessionFile([
      '{"type":"user"}',
      costState(0.0273),
      '{"type":"assistant"}',
      costState(0.0329),
      '{"type":"assistant"}',
    ]);

    expect(readLastClaudeCostState(path, SESSION)).toEqual({
      costUsd: 0.0329,
      apiMs: 2254,
    });
  });

  it('finds it behind more than one read of what a killed process wrote after it', () => {
    const filler = `{"type":"assistant","text":"${'x'.repeat(4096)}"}`;
    const path = sessionFile([
      costState(12.5),
      ...Array.from({ length: 600 }, () => filler),
    ]);

    expect(readLastClaudeCostState(path, SESSION)?.costUsd).toBe(12.5);
  });

  it('ignores a cost-state that names another session, and answers null when none is left', () => {
    const path = sessionFile([
      costState(9, 'other-session'),
      '{"type":"user"}',
    ]);

    expect(readLastClaudeCostState(path, SESSION)).toBeNull();
  });

  it('answers null for a file it cannot read', () => {
    expect(readLastClaudeCostState('/nonexistent/x.jsonl', SESSION)).toBeNull();
  });
});

describe('findClaudeSessionFileSync', () => {
  it('finds a session under any of the profile’s project directories', () => {
    const profile = mkdtempSync(join(tmpdir(), 'claude-profile-'));
    mkdirSync(join(profile, 'projects', '-Users-a-b'), { recursive: true });
    mkdirSync(join(profile, 'projects', '-Users-c'), { recursive: true });
    const path = join(profile, 'projects', '-Users-c', `${SESSION}.jsonl`);
    writeFileSync(path, '');

    expect(findClaudeSessionFileSync(profile, SESSION)).toBe(path);
    expect(findClaudeSessionFileSync(profile, 'missing')).toBeNull();
  });

  it('never builds a path from an id that is not a plain session id', () => {
    const profile = mkdtempSync(join(tmpdir(), 'claude-profile-'));

    expect(findClaudeSessionFileSync(profile, `../${SESSION}`)).toBeNull();
  });
});
