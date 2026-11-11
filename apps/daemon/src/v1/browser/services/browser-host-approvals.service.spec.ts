import { describe, expect, it } from 'vitest';

import { BrowserHostApprovals } from './browser-host-approvals.service';

describe('BrowserHostApprovals', () => {
  it('approves a host for one run only', () => {
    const approvals = new BrowserHostApprovals();

    approvals.approve('r1', 'example.com');

    expect(approvals.allows('r1', 'example.com')).toBe(true);
    expect(approvals.allows('r2', 'example.com')).toBe(false);
    expect(approvals.allows('r1', 'other.com')).toBe(false);
    expect(approvals.hosts('r1')).toEqual(['example.com']);
    expect(approvals.hosts('r2')).toEqual([]);
  });

  it('compares hosts lower-case', () => {
    const approvals = new BrowserHostApprovals();

    approvals.approve('r1', 'Example.COM');

    expect(approvals.allows('r1', 'EXAMPLE.com')).toBe(true);
    expect(approvals.hosts('r1')).toEqual(['example.com']);
  });

  it('approveAll allows every host of that run and no other', () => {
    const approvals = new BrowserHostApprovals();

    expect(approvals.allowsAll('r1')).toBe(false);
    approvals.approveAll('r1');

    expect(approvals.allowsAll('r1')).toBe(true);
    expect(approvals.allowsAll('r2')).toBe(false);
  });

  it('forget drops the hosts and the allow-all of the run', () => {
    const approvals = new BrowserHostApprovals();
    approvals.approve('r1', 'a.com');
    approvals.approveAll('r1');
    approvals.approve('r2', 'b.com');

    approvals.forget('r1');

    expect(approvals.allows('r1', 'a.com')).toBe(false);
    expect(approvals.allowsAll('r1')).toBe(false);
    expect(approvals.hosts('r1')).toEqual([]);
    expect(approvals.allows('r2', 'b.com')).toBe(true);
  });
});
