import { describe, expect, it } from 'vitest';

import {
  claudeDisallowedMcpArgs,
  claudeMcpServerRule,
  claudeMcpServerSegment,
} from './claude-mcp-tool-name.utils';

describe('claudeMcpServerSegment — the CLI’s own normalizer', () => {
  // Each pair is a server name and the tool-name segment claude 2.1.284
  // printed for it in `system/init`.
  it.each([
    ['codegraph', 'codegraph'],
    ['plugin:playwright:playwright', 'plugin_playwright_playwright'],
    ['claude.ai Booking.com', 'claude_ai_Booking_com'],
    ['claude.ai Google Calendar', 'claude_ai_Google_Calendar'],
    ['my-server_2', 'my-server_2'],
  ])('%s → %s', (server, segment) => {
    expect(claudeMcpServerSegment(server)).toBe(segment);
  });

  it('collapses underscore runs only for an account connector', () => {
    expect(claudeMcpServerSegment('a  b')).toBe('a__b');
    expect(claudeMcpServerSegment('claude.ai  a..b ')).toBe('claude_ai_a_b');
  });
});

describe('claudeMcpServerRule', () => {
  it('is a server-level rule for an ordinary name', () => {
    expect(claudeMcpServerRule('plugin:playwright:playwright')).toBe(
      'mcp__plugin_playwright_playwright',
    );
  });

  it('wildcards the tool part when the segment itself holds `__`', () => {
    // `mcp__a__b` would read as tool `b` of server `a`.
    expect(claudeMcpServerRule('a  b')).toBe('mcp__a__b__*');
  });
});

describe('claudeDisallowedMcpArgs', () => {
  it('adds nothing when nothing is switched off', () => {
    expect(claudeDisallowedMcpArgs(undefined, null)).toEqual([]);
    expect(claudeDisallowedMcpArgs([], 'geniro-run')).toEqual([]);
  });

  it('is ONE flag followed by every rule, de-duplicated', () => {
    expect(
      claudeDisallowedMcpArgs(
        ['codegraph', 'claude.ai Gmail', 'codegraph'],
        null,
      ),
    ).toEqual(['--disallowedTools', 'mcp__codegraph', 'mcp__claude_ai_Gmail']);
  });

  it('never withholds geniro’s own server', () => {
    expect(
      claudeDisallowedMcpArgs(['geniro-abc', 'codegraph'], 'geniro-abc'),
    ).toEqual(['--disallowedTools', 'mcp__codegraph']);
    expect(claudeDisallowedMcpArgs(['geniro-abc'], 'geniro-abc')).toEqual([]);
  });
});
