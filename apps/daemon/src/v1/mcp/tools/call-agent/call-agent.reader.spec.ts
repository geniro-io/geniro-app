import { describe, expect, it } from 'vitest';

import {
  type CheckedCallAgentArgs,
  validateCallAgentArgs,
} from './call-agent.reader';

const LEAD =
  'INVALID_ARGS: call call_agent({agent: "<member id>", message: "<the task>", title: "<why you call it>", mode: "async"}).';

const base = { agent_id: 'helper', message: 'find X', title: 'Find X' };

function acceptedOf(args: Record<string, unknown>): CheckedCallAgentArgs {
  const checked = validateCallAgentArgs(args);
  if ('status' in checked) {
    throw new Error(
      `expected the call to be accepted, got ${JSON.stringify(checked)}`,
    );
  }
  return checked;
}

function refusalOf(args: Record<string, unknown>): string {
  const checked = validateCallAgentArgs(args);
  if (!('status' in checked) || checked.status !== 'error') {
    throw new Error(`expected a refusal for ${JSON.stringify(args)}`);
  }
  return checked.error;
}

describe('validateCallAgentArgs', () => {
  it('reads agent_id as agent', () => {
    const { args } = acceptedOf(base);

    expect(args).toMatchObject({ agent: 'helper', message: 'find X' });
    expect(args).not.toHaveProperty('agent_id');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['async: true', { async: true }, 'async'],
    ['async: false', { async: false }, 'sync'],
    ['sync: true', { sync: true }, 'sync'],
    ['sync: "false"', { sync: 'false' }, 'async'],
    [
      'mode "async" beside async: true',
      { mode: 'async', async: true },
      'async',
    ],
  ])('reads %s as a call in the %s mode', (_flag, extra, mode) => {
    expect(acceptedOf({ ...base, ...extra }).args.mode).toBe(mode);
  });

  it('refuses mode, async and sync that disagree, with the right call first', () => {
    const error = refusalOf({ ...base, mode: 'sync', async: true });

    expect(error.split('\n')).toEqual([
      LEAD,
      "'mode', 'async' and 'sync' disagree — send 'mode' alone",
    ]);
  });

  it('refuses a flag that is not true or false, with the right call first', () => {
    expect(refusalOf({ ...base, async: 'yes' }).split('\n')).toEqual([
      LEAD,
      "'async' must be true or false",
    ]);
  });

  it('refuses agent_id and agent that disagree, naming both', () => {
    expect(refusalOf({ ...base, agent: 'other' }).split('\n')).toEqual([
      LEAD,
      'send agent once — agent_id and agent name the same argument and disagree',
    ]);
  });

  it('refuses a missing agent with the right call first', () => {
    expect(
      refusalOf({ message: 'find X', title: 'Find X' }).split('\n'),
    ).toEqual([LEAD, "'agent' must be a non-empty string"]);
  });

  it('refuses an argument it does not read, with the right call first', () => {
    const error = refusalOf({ ...base, timeout_seconds: '180' });

    expect(error.split('\n')[0]).toBe(LEAD);
    expect(error).toContain("'timeout_seconds'");
  });
});
