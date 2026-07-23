import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentTurnInput } from '../adapters/adapter.types';
import type { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import type { resolveAgentVersion } from '../utils/agent-version';
import {
  type ClaudeProbeOptions,
  ClaudeProbeService,
} from './claude-probe.service';
import { ProcessRegistry } from './process-registry';

type Behavior = 'init' | 'reject' | 'auth-error' | 'hang';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-spec-'));
  roots.push(root);
  return root;
}

/** A fake claude CLI: per-turn behavior keyed by the probed approvalMode. */
function fakeAdapter(behave: (input: AgentTurnInput) => Behavior): {
  adapter: ClaudeAdapter;
  starts: AgentTurnInput[];
  cancels: { count: number };
} {
  const starts: AgentTurnInput[] = [];
  const cancels = { count: 0 };
  const adapter = {
    start(input: AgentTurnInput, onEvent: (e: AgentEvent) => void) {
      starts.push(input);
      const behavior = behave(input);
      if (behavior === 'hang') {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return {
          done,
          cancel: () => {
            cancels.count += 1;
            resolveDone();
          },
          respondApproval: () => false,
        };
      }
      if (behavior === 'init') {
        onEvent({ type: 'session', sessionId: 'probe-session' });
      } else if (behavior === 'reject') {
        onEvent({
          type: 'error',
          message:
            `claude exited with code 1: error: option '--permission-mode <mode>' ` +
            `argument '${String(input.approvalMode)}' is invalid. Allowed choices are default, acceptEdits.`,
        });
      } else {
        onEvent({
          type: 'error',
          message: 'claude exited with code 1: not logged in',
        });
      }
      return {
        done: Promise.resolve(),
        cancel: () => {
          cancels.count += 1;
        },
        respondApproval: () => false,
      };
    },
  } as unknown as ClaudeAdapter;
  return { adapter, starts, cancels };
}

function build(
  behave: (input: AgentTurnInput) => Behavior,
  overrides: Partial<ClaudeProbeOptions> & { version?: string | null } = {},
): {
  service: ClaudeProbeService;
  starts: AgentTurnInput[];
  cancels: { count: number };
  cachePath: string;
} {
  const root = tempRoot();
  const cachePath = overrides.cachePath ?? join(root, 'claude-probe.json');
  const { adapter, starts, cancels } = fakeAdapter(behave);
  const service = new ClaudeProbeService(adapter, new ProcessRegistry(), {
    probeRootDir: join(root, 'probes'),
    cachePath,
    turnTimeoutMs: overrides.turnTimeoutMs ?? 1_000,
    resolveVersionFn: vi.fn(
      async () => overrides.version ?? 'claude 2.1.202',
    ) as unknown as typeof resolveAgentVersion,
  });
  return { service, starts, cancels, cachePath };
}

describe('ClaudeProbeService', () => {
  it('probes both modes with one turn each, passes on the session line, and cancels the rest of the turn', async () => {
    const { service, starts, cancels, cachePath } = build(() => 'init');
    const verdict = await service.ensureVerdict();
    expect(verdict.acceptEdits).toBe('pass');
    expect(verdict.plan).toBe('pass');
    expect(starts.map((s) => s.approvalMode)).toEqual(['acceptEdits', 'plan']);
    // Proof arrived with init — both turns were cancelled early.
    expect(cancels.count).toBe(2);
    // A genuine verdict is disk-cached keyed by the version line.
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      acceptEdits: string;
      version: string;
    };
    expect(cached.acceptEdits).toBe('pass');
    expect(cached.version).toBe('claude 2.1.202');
  });

  it('treats an argv rejection of the mode as a genuine, cacheable fail', async () => {
    const { service, cachePath } = build((input) =>
      input.approvalMode === 'plan' ? 'reject' : 'init',
    );
    const verdict = await service.ensureVerdict();
    expect(verdict.acceptEdits).toBe('pass');
    expect(verdict.plan).toBe('fail');
    expect(verdict.reason).toContain('--permission-mode plan');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      plan: string;
    };
    expect(cached.plan).toBe('fail');
  });

  it('keeps an environmental failure memory-only and re-probes on the next read', async () => {
    const { service, starts, cachePath } = build(() => 'auth-error');
    const verdict = await service.ensureVerdict();
    expect(verdict.acceptEdits).toBe('unknown');
    expect(verdict.plan).toBe('unknown');
    expect(existsSync(cachePath)).toBe(false);
    // Not memoized — the next read retries instead of sticking on unknown.
    await service.ensureVerdict();
    expect(starts.length).toBe(4);
  });

  it('times a hung probe turn out to unknown without disk-caching it', async () => {
    const { service, cancels, cachePath } = build(() => 'hang', {
      turnTimeoutMs: 20,
    });
    const verdict = await service.ensureVerdict();
    expect(verdict.acceptEdits).toBe('unknown');
    expect(verdict.plan).toBe('unknown');
    expect(verdict.reason).toContain('timed out');
    expect(cancels.count).toBe(2);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('reuses the per-version disk cache without spawning a probe turn', async () => {
    const shared = tempRoot();
    const cachePath = join(shared, 'claude-probe.json');
    const first = build(() => 'init', { cachePath });
    await first.service.ensureVerdict();
    expect(first.starts.length).toBe(2);

    const second = build(() => 'init', { cachePath });
    const verdict = await second.service.ensureVerdict();
    expect(verdict.acceptEdits).toBe('pass');
    expect(second.starts.length).toBe(0);

    // A different installed version ignores the stale cache and re-probes.
    const upgraded = build(() => 'init', {
      cachePath,
      version: 'claude 3.0.0',
    });
    await upgraded.service.ensureVerdict();
    expect(upgraded.starts.length).toBe(2);
  });

  it('wireCapability reports the current verdict and pre-warms the probe on unknown', async () => {
    const { service, starts } = build(() => 'init');
    const wire = service.wireCapability();
    expect(wire.acceptEdits).toBe('unknown');
    // The pre-warm fired in the background — joining it (single-flight) must
    // not start extra turns.
    await service.ensureVerdict();
    expect(starts.length).toBe(2);
    expect(service.wireCapability().acceptEdits).toBe('pass');
  });
});
