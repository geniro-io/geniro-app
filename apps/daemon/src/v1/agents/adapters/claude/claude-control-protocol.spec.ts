import { describe, expect, it } from 'vitest';

import {
  claudeVersionSeries,
  CONTROL_PROTOCOL_VERIFIED_SERIES,
  isControlProtocolVerified,
  unverifiedControlProtocolMessage,
} from './claude-control-protocol';

describe('claudeVersionSeries', () => {
  it('reduces a real --version line to its major.minor series', () => {
    expect(claudeVersionSeries('2.1.220 (Claude Code)')).toBe('2.1');
    expect(claudeVersionSeries('2.1.202 (Claude Code)')).toBe('2.1');
  });

  it('answers null when the line carries no version', () => {
    expect(claudeVersionSeries(null)).toBeNull();
    expect(claudeVersionSeries('')).toBeNull();
    expect(claudeVersionSeries('Claude Code')).toBeNull();
    // Two components is not a version we can series-match.
    expect(claudeVersionSeries('2.1')).toBeNull();
  });
});

describe('isControlProtocolVerified', () => {
  it('accepts the versions the protocol was actually probed against', () => {
    // Both probe dates recorded in the constant's doc block.
    expect(isControlProtocolVerified('2.1.202 (Claude Code)')).toBe(true);
    expect(isControlProtocolVerified('2.1.220 (Claude Code)')).toBe(true);
  });

  it('rejects a series nobody probed', () => {
    expect(isControlProtocolVerified('3.0.0 (Claude Code)')).toBe(false);
    expect(isControlProtocolVerified('2.2.0 (Claude Code)')).toBe(false);
  });

  it('treats an unreadable version as unverified, never as verified', () => {
    // "We could not ask" is the absence of evidence, so it must report — the
    // opposite default would make a broken `--version` look like a pass.
    expect(isControlProtocolVerified(null)).toBe(false);
    expect(isControlProtocolVerified('who knows')).toBe(false);
  });

  it('keeps the constant and the predicate in agreement', () => {
    // Guards the pair against drifting apart: every series we claim to have
    // verified must actually pass the predicate.
    for (const series of CONTROL_PROTOCOL_VERIFIED_SERIES) {
      expect(isControlProtocolVerified(`${series}.0 (Claude Code)`)).toBe(true);
    }
  });
});

describe('unverifiedControlProtocolMessage', () => {
  it('names the version it saw and the series it wanted', () => {
    const message = unverifiedControlProtocolMessage('3.0.0 (Claude Code)');
    expect(message).toContain('3.0.0');
    expect(message).toContain(CONTROL_PROTOCOL_VERIFIED_SERIES.join(', '));
  });

  it('says so explicitly when there was no version to read', () => {
    expect(unverifiedControlProtocolMessage(null)).toContain(
      '<unknown version>',
    );
  });
});
