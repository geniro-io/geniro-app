import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type {
  AgentContextUsage,
  UsageReading,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { PlanLimitsWire, RunItemEvent } from '../chat.types';
import { ChatMetricsWireSchema } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import type { AgentSessionRegistry } from './agent-session.registry';
import { ChatMetricsService } from './chat-metrics.service';
import type { CursorUsageService } from './cursor-usage.service';

/**
 * Every NAMED component of the wire shape populated, not just the top level.
 *
 * `memoryFiles` and `servers` were empty here, and the wire round-trip below
 * reads whatever this fixture produces — so `ContextMemoryFile` and
 * `ContextServer` were never entered, and dropping a field from either passed
 * the whole suite AND the type gate while losing that field on the way to the
 * renderer. A fixture that skips an arm cannot pin the arm.
 */
const BREAKDOWN: AgentContextUsage = {
  categories: [
    { name: 'System prompt', tokens: 3386, deferred: false },
    { name: 'MCP tools', tokens: 273_876, deferred: true },
  ],
  totalTokens: 3386,
  maxTokens: 1_000_000,
  model: 'claude-opus-5[1m]',
  autoCompactAtTokens: 967_000,
  autoCompactEnabled: true,
  memoryFiles: [{ path: '/proj/CLAUDE.md', kind: 'Project', tokens: 45_947 }],
  servers: [
    { name: 'amplitude', tokens: 109_284, toolCount: 33, loadedToolCount: 0 },
  ],
};

/** One stored `turn_complete` payload, as the transcript holds it. */
function turn(usage: Record<string, unknown> | null): string {
  return JSON.stringify({ usage, stopReason: 'end_turn' });
}

function build(opts: {
  agentKind?: AgentKind | null;
  runExists?: boolean;
  payloads?: string[];
  breakdown?: AgentContextUsage | null;
  /**
   * What this CLI says about the breakdown — whether it can be asked at all,
   * and through WHICH channel. Defaults to the on-disk channel, which is the
   * shape every case written before the channel existed assumed: a recorded
   * session id was enough to ask through.
   */
  breakdownReading?: UsageReading;
  readContextUsage?: () => Promise<AgentContextUsage | null>;
  /**
   * What the run holds to be asked THROUGH. Defaults to a recorded session id,
   * which is the shape every existing case was written against; `null` on both
   * is the chat with nothing to ask at all.
   */
  agentSessionId?: string | null;
  liveSession?: unknown;
  /** What the run row holds as its last farewell reading, verbatim JSON. */
  lastMetricsReading?: string | null;
  /** The profile the run is on NOW — what a stored reading is checked against. */
  configDir?: string | null;
  /** Where the transcript stands NOW — what a stored `atSeq` is checked against. */
  maxSeq?: number;
  readPlanLimits?: () => Promise<PlanLimitsWire | null>;
  planReading?: UsageReading;
}) {
  const remembered = vi.fn().mockResolvedValue(undefined);
  const turns = new Subject<RunItemEvent>();
  let farewell: ((runId: string) => Promise<void>) | null = null;
  const readContextUsage =
    opts.readContextUsage ??
    vi.fn().mockResolvedValue('breakdown' in opts ? opts.breakdown : BREAKDOWN);
  const service = new ChatMetricsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      rememberMetricsReading: remembered,
      getById: () =>
        Promise.resolve(
          opts.runExists === false
            ? null
            : {
                agentKind:
                  'agentKind' in opts ? opts.agentKind : AgentKind.Claude,
                lastMetricsReading: opts.lastMetricsReading ?? null,
                configDir: opts.configDir ?? null,
              },
        ),
    } as unknown as RunDao,
    {
      turnCompletePayloads: () => Promise.resolve(opts.payloads ?? []),
      maxSeq: () => Promise.resolve(opts.maxSeq ?? 7),
    } as unknown as ItemDao,
    {
      getByRunNode: () =>
        Promise.resolve({
          agentSessionId:
            'agentSessionId' in opts ? opts.agentSessionId : 'sess-1',
        }),
    } as unknown as NodeStateDao,
    {
      peek: () => opts.liveSession ?? null,
      onIdleFarewell: (listener: (runId: string) => Promise<void>) => {
        farewell = listener;
      },
    } as unknown as AgentSessionRegistry,
    {
      for: () =>
        ({
          getConfig: () => ({
            usage: {
              unavailableReason: null,
              breakdown: opts.breakdownReading ?? {
                kind: 'reads',
                channel: 'session-store',
              },
              // Out of the way of every breakdown case: this fake CLI has no
              // plan channel, so nothing here asks for one.
              planLimits: opts.planReading ?? {
                kind: 'unavailable',
                reason: 'this fake CLI reports no plan limits',
              },
            },
          }),
          readContextUsage,
          readPlanLimits: opts.readPlanLimits ?? (() => Promise.resolve(null)),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry,
    // The prewarm's own channel. A Subject rather than a stub, so a spec can
    // play a real turn ending and watch what the service does about it.
    { all: () => turns.asObservable() } as unknown as AgentEventBus,
    // The cursor spend poll. A no-op double: every spec here is about the
    // BREAKDOWN, and the service only ever fires this without awaiting it, so a
    // real one would put a network read behind assertions about a readout.
    { refresh: () => Promise.resolve() } as unknown as CursorUsageService,
  );
  service.onModuleInit();
  return {
    service,
    readContextUsage,
    remembered,
    /** Fire what the session registry would fire on an idle close. */
    farewell: () => farewell!('run-1'),
    /** Play a settled turn onto the agent bus, as the chat service would. */
    settleTurn: (runId = 'run-1') =>
      turns.next({
        runId,
        item: { kind: 'turn_complete', seq: opts.maxSeq ?? 7 },
      } as unknown as RunItemEvent),
  };
}

describe('ChatMetricsService', () => {
  it('answers with the live breakdown and no reason when one was taken', () => {
    const { service } = build({});

    return expect(service.read('run-1')).resolves.toMatchObject({
      context: BREAKDOWN,
      breakdownReason: null,
    });
  });

  it('answers something the wire schema accepts UNCHANGED', async () => {
    // The route serializes this reply THROUGH `ChatMetricsWireSchema`
    // (`@ZodResponse` → `ChatMetricsDto`), and zod strips what the schema does
    // not name — silently, so a field the service produces and the schema
    // omits vanishes between here and the renderer with nothing failing. The
    // strict parse is what makes that a test failure instead; comparing the
    // parsed value back against the original is what catches a DROPPED field,
    // which a bare `.parse()` would let through.
    //
    // Driven with every named component populated AND with real totals: the
    // check can only reach the arms the fixture reaches, so an empty
    // `memoryFiles` left `ContextMemoryFile` unverified, and all-null totals
    // left every `ChatTotals` field's non-null arm unverified.
    const { service } = build({
      payloads: [
        turn({
          costUsd: 0.42,
          inputTokens: 24,
          outputTokens: 1_200,
          cacheReadTokens: 1_300_000,
          cacheCreationTokens: 210_000,
          thinkingTokens: 300,
          durationMs: 252_000,
        }),
      ],
    });

    const metrics = await service.read('run-1');

    // The fixture actually reached the nested arms — otherwise this test
    // certifies the top level alone while reading as though it covered all of
    // it, which is what it did before.
    expect(metrics.context?.memoryFiles).toHaveLength(1);
    expect(metrics.context?.servers).toHaveLength(1);
    expect(metrics.totals.costUsd).not.toBeNull();
    expect(ChatMetricsWireSchema.parse(metrics)).toEqual(metrics);
  });

  it('names the CLI’s OWN reason when it has no such channel', async () => {
    // The whole point of the field: an agent that will never answer must read
    // differently from one whose process has simply been reaped.
    const { service, readContextUsage } = build({
      agentKind: AgentKind.CursorAgent,
      breakdownReading: {
        kind: 'unavailable',
        reason: 'cursor-agent has no channel for one',
      },
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toBe('cursor-agent has no channel for one');
    // Not even asked — the adapter has already said there is nothing to ask.
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it('tells the user how to get one back when the chat holds no process', async () => {
    // NOTHING to ask through: no live process and no recorded session id.
    const { service, readContextUsage } = build({
      breakdown: null,
      agentSessionId: null,
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toContain('send a message');
    // And it was not asked, because there was nobody to ask.
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  describe('the last reading of a process that has since been closed', () => {
    const STORED = JSON.stringify({
      takenAt: '2026-08-26T13:18:49.000Z',
      atSeq: 7,
      configDir: null,
      context: BREAKDOWN,
      plan: null,
    });

    it('shows it when there is no agent left to ask, stamped with when it was taken', async () => {
      // The other half of the reported "wrong popup withoput data": correcting
      // the sentence stopped the panel lying, and left it empty. claude answers
      // both figures from its running process alone, so a chat whose session
      // was reaped had nothing to show until the user spent a turn reviving it.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        lastMetricsReading: STORED,
      });

      const metrics = await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
      expect(metrics.context).toEqual(BREAKDOWN);
      expect(metrics.breakdownReason).toBeNull();
      // The stamp is not decoration: these figures are the state a
      // conversation was left in, and undated they read as current.
      expect(metrics.takenAt).toBe('2026-08-26T13:18:49.000Z');
    });

    it('drops it once the transcript has MOVED past what it describes', async () => {
      // A session closed some other way — evicted for the ceiling, or a daemon
      // restart — takes no farewell reading, so the run keeps an older one
      // while its conversation goes on growing. Figures from before those turns
      // describe a window that no longer exists, and a timestamp does not make
      // them true.
      const { service } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        lastMetricsReading: STORED,
        maxSeq: 12,
      });

      const metrics = await service.read('run-1');

      expect(metrics.context).toBeNull();
      expect(metrics.takenAt).toBeNull();
      expect(metrics.breakdownReason).toContain('send a message');
    });

    it('drops a reading whose SHAPE it can no longer read', async () => {
      // Stored JSON outlives the code that wrote it. Half a breakdown drawn
      // from a shape that has moved is worse than the sentence saying there is
      // none, so it is discarded rather than coerced.
      const { service } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        lastMetricsReading: JSON.stringify({
          takenAt: '2026-08-26T13:18:49.000Z',
          atSeq: 7,
          context: { categories: 'all of them' },
          plan: null,
        }),
      });

      const metrics = await service.read('run-1');

      expect(metrics.context).toBeNull();
      expect(metrics.breakdownReason).toContain('send a message');
    });

    it('never dates a LIVE answer with an older reading’s moment', async () => {
      // `takenAt` says "these figures are from then". A CLI that answered now
      // must not wear it, or the panel reports a current reading as stale.
      const { service } = build({
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: STORED,
      });

      const metrics = await service.read('run-1');

      expect(metrics.context).toEqual(BREAKDOWN);
      expect(metrics.takenAt).toBeNull();
    });

    it('takes one on the way out, against the transcript position it describes', async () => {
      // The registry's idle close awaits this — the last moment the process can
      // be asked anything at all.
      const { farewell, remembered, readContextUsage } = build({
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        maxSeq: 9,
      });

      await farewell();

      expect(readContextUsage).toHaveBeenCalled();
      const [runId, json] = remembered.mock.calls[0] ?? [];
      expect(runId).toBe('run-1');
      expect(JSON.parse(String(json))).toMatchObject({
        atSeq: 9,
        context: BREAKDOWN,
      });
    });

    it('does NOT ask again when a stored reading still describes this conversation', async () => {
      // REPORTED as "'reading agent context' is too slow when i hover on
      // current context circly. Why it working without delays for claude /
      // cursor in their UI?" — because those UIs ARE the CLI and the figures
      // are already in its memory. geniro has to ask over stdin, measured at
      // 1.84–2.18s against a warm claude, and it paid that on EVERY open: the
      // stored reading was consulted only where the live answer came back
      // empty, so a second hover a minute later, with not a word said in
      // between, asked the whole question again.
      //
      // `atSeq` is what makes reusing it safe, and the next case pins the
      // other side of that.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: STORED,
        maxSeq: 7,
      });

      const metrics = await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
      expect(metrics.context).toEqual(BREAKDOWN);
      // Not dated: nothing has been said since it was taken, so these figures
      // ARE what the agent would answer. The stamp drives the panel's "the
      // agent was closed — send a message" line, which would be false here.
      expect(metrics.takenAt).toBeNull();
      expect(metrics.breakdownReason).toBeNull();
    });

    /**
     * The same stored reading, but carrying an ALLOWANCE — which is the half
     * `atSeq` cannot vouch for.
     */
    const storedWithPlan = (
      takenAt: string,
      configDir: string | null = null,
    ): string =>
      JSON.stringify({
        takenAt,
        atSeq: 7,
        configDir,
        context: BREAKDOWN,
        plan: {
          plan: 'team',
          windows: [
            {
              key: 'weekly_all',
              label: 'Current week',
              percent: 100,
              resetsAt: '2026-08-29T09:00:00.000Z',
            },
          ],
        },
      });

    it('asks again for an allowance the transcript cannot vouch for', async () => {
      // REPORTED as "I STILL have team session", against a panel reading
      // `TEAM · Current week 100% · resets in 1d 15h`. `atSeq` is the whole
      // guard on the shortcut, and it is right about the CONTEXT and blind to
      // the ALLOWANCE: a week rolls, an account changes plan, and every turn
      // spent in another chat or another terminal moves the figure without
      // writing a row here. Reconstructed from the reporter's own geniro.db —
      // six runs holding `plan: "team"` at 100%, all still servable, the
      // oldest twelve hours old, while the same profile asked live answered
      // `max` with its week at 1%.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan('2026-08-26T13:18:49.000Z'),
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('asks again when the chat has CHANGED ACCOUNT since the reading', async () => {
      // REPORTED as a panel reading `TEAM · Current week 100%` on a chat whose
      // profile chip said `.claude-manifest-lab-personal`. Both profiles were
      // on disk — `.claude-manifest-lab` is `claude_team`, `-personal` is
      // `claude_max` — and the transcript carried the app's own row saying the
      // chat had been switched to the personal one, which brings the
      // conversation across. So `atSeq` was untouched and every account-level
      // figure in the reading belonged to the account the chat had left.
      //
      // Fresh in TIME, deliberately: the age bound cannot see this, which is
      // the whole reason the profile is its own key.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(
          new Date().toISOString(),
          '/Users/x/ManifestLab/.claude-manifest-lab',
        ),
        configDir: '/Users/x/ManifestLab/.claude-manifest-lab-personal',
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('serves a reading taken under the profile the chat is STILL on', async () => {
      // The other side of that key: a chat that never switched keeps the
      // shortcut, or the fix would cost every profiled chat the full ask.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(
          new Date().toISOString(),
          '/Users/x/ManifestLab/.claude-manifest-lab-personal',
        ),
        configDir: '/Users/x/ManifestLab/.claude-manifest-lab-personal',
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
    });

    it('files the profile it read under, so the next open can check it', async () => {
      // Without the write there is nothing to compare and every stored reading
      // fails the parse forever — the shortcut would simply never fire again.
      const { service, remembered } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: null,
        configDir: '/Users/x/ManifestLab/.claude-manifest-lab-personal',
        maxSeq: 4,
      });

      await service.read('run-1');
      await Promise.resolve();
      await Promise.resolve();

      const [, json] = remembered.mock.calls[0] ?? [];
      expect(JSON.parse(String(json))).toMatchObject({
        configDir: '/Users/x/ManifestLab/.claude-manifest-lab-personal',
      });
    });

    it('still serves an allowance taken moments ago, which is what the shortcut is FOR', async () => {
      // The other side of the bound. Without this arm the fix could be "never
      // reuse a plan reading", which puts the reported two-second wait back on
      // every hover.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(new Date().toISOString()),
        maxSeq: 7,
      });

      const metrics = await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
      expect(metrics.plan?.plan).toBe('team');
      expect(metrics.takenAt).toBeNull();
    });

    it('refuses to date an allowance whose stamp will not parse', async () => {
      // An unparseable stamp is not evidence of freshness — it is the absence
      // of evidence, and the defensive branch this asserts is the one a later
      // "dead code" pass would otherwise delete.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan('not a timestamp'),
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('asks again the moment the transcript has moved', async () => {
      // The guard the shortcut rests on. One new row of any kind and the
      // stored figures describe a window that no longer exists — so this is
      // the case that must still pay the two seconds.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: STORED,
        maxSeq: 8,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('FILES a live answer, so the next open is the fast one', async () => {
      // Without this the shortcut above could never fire on a chat the user is
      // actually in: readings were only ever written on a session's way out,
      // so the first open asked, wrote nothing, and the second open asked
      // again. The write is not awaited — the reader is waiting on the reply
      // and the file is for whoever opens next — so this drains the microtask
      // queue before looking.
      const { service, remembered } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: null,
        maxSeq: 4,
      });

      await service.read('run-1');
      await new Promise((resolve) => setTimeout(resolve, 0));

      const [runId, json] = remembered.mock.calls[0] ?? [];
      expect(runId).toBe('run-1');
      expect(JSON.parse(String(json))).toMatchObject({
        atSeq: 4,
        context: BREAKDOWN,
      });
    });

    it('takes a reading when a WATCHED chat settles a turn, and only then', async () => {
      // The prewarm, and the gate on it. Asking costs a real control write on
      // the user's own agent, so it is spent on chats whose readout they have
      // opened — never as a tax on every turn of every conversation.
      const { service, readContextUsage, settleTurn } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        maxSeq: 9,
      });

      // Nobody has opened this chat's readout yet.
      settleTurn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vi.mocked(readContextUsage)).not.toHaveBeenCalled();

      // Opening it is what marks the chat as watched. That open ASKS (nothing
      // is stored yet), so the prewarm's own ask is the SECOND call — counted
      // rather than cleared, since the default double is not always a spy.
      await service.read('run-1');
      const afterOpen = vi.mocked(readContextUsage).mock.calls.length;

      settleTurn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vi.mocked(readContextUsage).mock.calls.length).toBeGreaterThan(
        afterOpen,
      );
    });

    it('files nothing when the agent answered neither question', async () => {
      // A row of nulls would be indistinguishable from a reading that was
      // taken and found the window empty — and it would OVERWRITE a good
      // earlier one with an empty one.
      const { farewell, remembered } = build({
        breakdown: null,
        liveSession: { ask: () => Promise.resolve(null) },
      });

      await farewell();

      expect(remembered).not.toHaveBeenCalled();
    });
  });

  it('says the same when the CLI reads from a PROCESS and the session id is all that is left', async () => {
    // The reported "wrong popup without data", reproduced from the author's own
    // daemon log: claude reads both figures from the running process, that
    // process was reaped as unused at 13:18:49, and the readout opened at
    // 13:37:07 — with no warning in between, because nothing had been asked.
    // A recorded session id is no channel here, and treating "either channel
    // exists" as "there was something to ask" made this chat report that the
    // agent "did not answer in time … the reading is taken again while this
    // stays open" — a promise nothing could keep.
    const { service, readContextUsage } = build({
      breakdownReading: { kind: 'reads', channel: 'live-process' },
      agentSessionId: 'sess-1',
    });

    const metrics = await service.read('run-1');

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toContain('send a message');
    expect(metrics.breakdownReason).not.toContain('did not answer');
  });

  it('does NOT tell the user to send a message when the agent was there and stayed silent', async () => {
    // The reported shape: an agent mid-turn whose context request did not come
    // back. "Send a message to take a fresh reading" is the cure for the case
    // above and a red herring here — the channel exists, so looking again is
    // what produces a reading, and a message costs the user a turn for nothing.
    const { service, readContextUsage } = build({
      breakdown: null,
      liveSession: { ask: () => Promise.resolve(null) },
    });

    const metrics = await service.read('run-1');

    expect(readContextUsage).toHaveBeenCalled();
    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).not.toContain('send a message');
    expect(metrics.breakdownReason).toContain('did not answer');
  });

  it('reads a THROWN live reading as silence, not as an absent agent', async () => {
    const { service } = build({
      readContextUsage: () => Promise.reject(new Error('stdin gone')),
      liveSession: { ask: () => Promise.reject(new Error('stdin gone')) },
    });

    const metrics = await service.read('run-1');

    expect(metrics.breakdownReason).toContain('did not answer');
  });

  it('answers the totals even when the breakdown could not be taken', async () => {
    // The two halves are independent: the spend is persisted history and is
    // always there, and losing it with the live reading would be the readout
    // going blank on every idle chat.
    const { service } = build({
      breakdown: null,
      payloads: [turn({ costUsd: 0.25, inputTokens: 10 })],
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.totals).toMatchObject({ turns: 1, costUsd: 0.25 });
  });

  it('survives a live reading that threw, rather than failing the request', async () => {
    const { service } = build({
      readContextUsage: () => Promise.reject(new Error('stdin gone')),
      payloads: [turn({ costUsd: 1 })],
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.totals.costUsd).toBe(1);
  });

  it('sums every figure across the thread’s turns', async () => {
    const { service } = build({
      payloads: [
        turn({
          costUsd: 0.2,
          inputTokens: 2,
          outputTokens: 16,
          cacheReadTokens: 100,
          cacheCreationTokens: 20,
          thinkingTokens: 4,
          durationMs: 2531,
        }),
        turn({
          costUsd: 0.3,
          inputTokens: 3,
          outputTokens: 24,
          cacheReadTokens: 900,
          cacheCreationTokens: 80,
          thinkingTokens: 6,
          durationMs: 1000,
        }),
      ],
    });

    expect((await service.read('run-1')).totals).toEqual({
      turns: 2,
      costedTurns: 2,
      costUsd: 0.5,
      inputTokens: 5,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheCreationTokens: 100,
      thinkingTokens: 10,
      workedMs: 3531,
    });
  });

  it('leaves a figure NO turn reported null rather than zero', async () => {
    // A chat on a CLI that reports no usage must read as "not measured", never
    // as "cost nothing" — the two are indistinguishable once seeded at 0.
    const { service } = build({
      payloads: [turn({ inputTokens: 5 })],
    });

    const { totals } = await service.read('run-1');

    expect(totals.inputTokens).toBe(5);
    expect(totals.costUsd).toBeNull();
    expect(totals.thinkingTokens).toBeNull();
    expect(totals.workedMs).toBeNull();
  });

  it('counts only the turns that actually reported usage', async () => {
    const { service } = build({
      payloads: [turn({ costUsd: 1 }), turn(null), 'not json at all'],
    });

    expect((await service.read('run-1')).totals).toMatchObject({
      turns: 1,
      costUsd: 1,
    });
  });

  it('refuses a run that does not exist', () => {
    const { service } = build({ runExists: false });

    return expect(service.read('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('says a run naming no single agent has no one window to report', async () => {
    const { service, readContextUsage } = build({ agentKind: null });

    const metrics = await service.read('run-1');

    expect(metrics.breakdownReason).toContain('no single agent');
    expect(readContextUsage).not.toHaveBeenCalled();
  });
});

describe('ChatMetricsService.readTotals', () => {
  it('sums the thread WITHOUT asking the agent — the whole reason it is a second route', async () => {
    // The header carries this figure on every thread the user opens, so it must
    // not cost the CLI round trip `read` pays for the breakdown (measured at
    // 1.2–3.3s). A `readTotals` that fell back to `read` would put that latency
    // on switching chats, and nothing about the answer would look wrong.
    const { service, readContextUsage } = build({
      payloads: [
        turn({ costUsd: 0.25, inputTokens: 10 }),
        turn({ costUsd: 0.5, inputTokens: 4 }),
      ],
    });

    const totals = await service.readTotals('run-1');

    expect(totals.costUsd).toBeCloseTo(0.75, 10);
    expect(totals.turns).toBe(2);
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it('answers a thread nothing measured with null, never zero', async () => {
    // cursor-agent reports no cost unless its currency is USD, so `$0.00` in
    // the header would be the app inventing a figure the CLI declined to give.
    const { service } = build({ payloads: [turn({ inputTokens: 10 })] });

    expect((await service.readTotals('run-1')).costUsd).toBeNull();
  });

  it('404s on a run that does not exist, rather than answering an empty sum', async () => {
    // An empty total is what a real, unused thread looks like — so a missing
    // run answering `turns: 0` would render as a genuine reading of nothing.
    const { service } = build({ runExists: false });

    await expect(service.readTotals('nope')).rejects.toThrow(/not found/);
  });
});
