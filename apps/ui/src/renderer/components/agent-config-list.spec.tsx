// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { CliDetection, CliKind } from '../../shared/contracts';
import { needsApiKey, statusFor } from './agent-config-list';
import type { StatusTone } from './status-dot';

function det(
  kind: CliKind,
  overrides: Partial<CliDetection> = {},
): CliDetection {
  return {
    kind,
    found: true,
    path: `/bin/${kind}`,
    version: '1.2.3',
    ...overrides,
  };
}

const bothFound: CliDetection[] = [det('claude'), det('cursor-agent')];
const noneFound: CliDetection[] = [
  det('claude', { found: false, path: null, version: null }),
  det('cursor-agent', { found: false, path: null, version: null }),
];

describe('needsApiKey', () => {
  it('key-gates cursor-agent only', () => {
    expect(needsApiKey('cursor-agent')).toBe(true);
    expect(needsApiKey('claude')).toBe(false);
  });
});

describe('statusFor', () => {
  // The full found × keyPresent tone matrix — a detected-but-keyless
  // cursor-agent is warn (it can't run yet), never ok.
  it.each([
    { kind: 'claude', keyPresent: false, tone: 'ok' },
    { kind: 'claude', keyPresent: true, tone: 'ok' },
    { kind: 'cursor-agent', keyPresent: false, tone: 'warn' },
    { kind: 'cursor-agent', keyPresent: true, tone: 'ok' },
  ] as { kind: CliKind; keyPresent: boolean; tone: StatusTone }[])(
    'found $kind with keyPresent=$keyPresent → $tone',
    ({ kind, keyPresent, tone }) => {
      expect(statusFor(bothFound, kind, keyPresent).tone).toBe(tone);
    },
  );

  it.each([
    { kind: 'claude', keyPresent: false },
    { kind: 'claude', keyPresent: true },
    { kind: 'cursor-agent', keyPresent: false },
    // A present key must never mask a missing binary.
    { kind: 'cursor-agent', keyPresent: true },
  ] as { kind: CliKind; keyPresent: boolean }[])(
    'not-found $kind is bad regardless of keyPresent=$keyPresent',
    ({ kind, keyPresent }) => {
      expect(statusFor(noneFound, kind, keyPresent)).toEqual({
        label: 'not found on PATH',
        tone: 'bad',
      });
      // A kind with no detection entry at all reads the same as not-found.
      expect(statusFor([], kind, keyPresent).tone).toBe('bad');
    },
  );

  it('reports unknown while detection is still running (clis null)', () => {
    for (const kind of ['claude', 'cursor-agent'] as CliKind[]) {
      expect(statusFor(null, kind, false)).toEqual({
        label: 'Checking…',
        tone: 'unknown',
      });
      expect(statusFor(null, kind, true).tone).toBe('unknown');
    }
  });

  it('labels carry the probed version when present', () => {
    expect(statusFor(bothFound, 'claude', false).label).toBe('ready · 1.2.3');
    expect(statusFor(bothFound, 'cursor-agent', false).label).toBe(
      'detected · 1.2.3 · needs API key',
    );
    expect(statusFor(bothFound, 'cursor-agent', true).label).toBe(
      'ready · 1.2.3',
    );

    const versionless = [
      det('claude', { version: null }),
      det('cursor-agent', { version: null }),
    ];
    expect(statusFor(versionless, 'claude', false).label).toBe('ready');
    expect(statusFor(versionless, 'cursor-agent', false).label).toBe(
      'detected · needs API key',
    );
  });
});
