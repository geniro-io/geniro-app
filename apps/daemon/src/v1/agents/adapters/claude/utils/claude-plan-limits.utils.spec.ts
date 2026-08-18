import { describe, expect, it } from 'vitest';

import {
  planLimitsRequestLine,
  readPlanLimitsReply,
} from './claude-plan-limits.utils';

const REQUEST_ID = 'req-1';

/**
 * The reply as the CLI actually sent it, trimmed to the branches under test.
 * Captured from a live 2.1.234 process (see the probe block at
 * `CLAUDE_PLAN_LIMITS_SUBTYPE` in `claude.const.ts`) rather than invented, so
 * the reader is exercised against the shape it will meet.
 */
const reply = (response: unknown): unknown => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: REQUEST_ID, response },
});

const LIVE_BODY = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 43, resets_at: '2026-08-18T11:00:00+00:00' },
    seven_day: { utilization: 30, resets_at: '2026-08-23T11:00:00+00:00' },
    seven_day_opus: null,
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 43,
        severity: 'normal',
        resets_at: '2026-08-18T11:00:00+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 30,
        severity: 'normal',
        resets_at: '2026-08-23T11:00:00+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 0,
        severity: 'normal',
        resets_at: null,
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
  },
  behaviors: { day: {}, week: {} },
  session: { total_cost_usd: 0 },
};

describe('planLimitsRequestLine', () => {
  it('asks the subtype the probe found, on one newline-terminated line', () => {
    const line = planLimitsRequestLine(REQUEST_ID);

    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: REQUEST_ID,
      request: { subtype: 'get_usage' },
    });
  });
});

describe('readPlanLimitsReply', () => {
  it('projects the windows the CLI reports, naming the scoped one from the payload', () => {
    const limits = readPlanLimitsReply(reply(LIVE_BODY), REQUEST_ID);

    expect(limits).toEqual({
      plan: 'max',
      windows: [
        {
          key: 'session',
          label: 'Current session',
          percent: 43,
          resetsAt: '2026-08-18T11:00:00+00:00',
        },
        {
          key: 'weekly_all',
          label: 'Current week',
          percent: 30,
          resetsAt: '2026-08-23T11:00:00+00:00',
        },
        // The whole reason `limits[]` is read instead of the named
        // five_hour/seven_day map beside it: the model's display name is in
        // the payload and could not be reconstructed from a key here.
        {
          key: 'weekly_scoped',
          label: 'Current week · Fable',
          percent: 0,
          resetsAt: null,
        },
      ],
    });
  });

  it('DROPS a window it cannot name rather than labelling it from its key', () => {
    const limits = readPlanLimitsReply(
      reply({
        ...LIVE_BODY,
        rate_limits: {
          limits: [
            LIVE_BODY.rate_limits.limits[0],
            // A kind this build does not know, with no scope to name it from.
            { kind: 'monthly_org_spend', percent: 91, resets_at: null },
          ],
        },
      }),
      REQUEST_ID,
    );

    // One row, not two, and not a row reading "monthly_org_spend 91%": a
    // vendor's new window appears when it is read here on purpose, and a
    // mislabelled limit is worse than a missing one.
    expect(limits?.windows.map((w) => w.key)).toEqual(['session']);
  });

  it('drops a window with no percentage instead of reading it as 0%', () => {
    const limits = readPlanLimitsReply(
      reply({
        ...LIVE_BODY,
        rate_limits: {
          limits: [
            LIVE_BODY.rate_limits.limits[0],
            { kind: 'weekly_all', percent: null, resets_at: null },
          ],
        },
      }),
      REQUEST_ID,
    );

    // "0% used" is the most reassuring thing the panel can say, and saying it
    // about a limit whose state is unknown is the one wrong answer here.
    expect(limits?.windows.map((w) => w.key)).toEqual(['session']);
  });

  it('clamps a percentage that would draw past its own bar', () => {
    const limits = readPlanLimitsReply(
      reply({
        ...LIVE_BODY,
        rate_limits: { limits: [{ kind: 'session', percent: 103 }] },
      }),
      REQUEST_ID,
    );

    expect(limits?.windows[0]).toEqual({
      key: 'session',
      label: 'Current session',
      percent: 100,
      resetsAt: null,
    });
  });

  it('answers null for an account that reports no windows at all', () => {
    // An API-key session answers `rate_limits_available: false` with nothing
    // under it. Reading that as an empty list would render "no limits" about a
    // reply that says nothing — the caller has a sentence for the latter.
    expect(
      readPlanLimitsReply(
        reply({ subscription_type: null, rate_limits_available: false }),
        REQUEST_ID,
      ),
    ).toBeNull();
  });

  it('ignores another question’s reply, a refusal, and a non-control line', () => {
    // The id match is what lets two readouts be open at once: the CLI
    // serialises its answers, so a reader taking the first reply it sees would
    // report a later moment than the one it asked about.
    expect(readPlanLimitsReply(reply(LIVE_BODY), 'other-request')).toBeNull();
    expect(
      readPlanLimitsReply(
        {
          type: 'control_response',
          response: { subtype: 'error', request_id: REQUEST_ID },
        },
        REQUEST_ID,
      ),
    ).toBeNull();
    expect(
      readPlanLimitsReply({ type: 'assistant', message: {} }, REQUEST_ID),
    ).toBeNull();
  });
});
