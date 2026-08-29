import { describe, expect, it, vi } from 'vitest';

import type { HostFindingsReport } from '../chat.types';
import { FindingsReportBroker } from './findings-report.broker';

const RUN = 'run-1';
const NODE = 'agent';

const REPORT: HostFindingsReport = {
  level: 'high',
  findings: [
    {
      file: 'src/a.ts',
      summary: 'A guard was weakened',
      failureScenario: 'A late writer wins the race.',
    },
  ],
};

describe('FindingsReportBroker', () => {
  it('cannot report until a turn registers a reporter', () => {
    const broker = new FindingsReportBroker();
    expect(broker.canReport(RUN, NODE)).toBe(false);
    broker.register(RUN, NODE, async () => ({ status: 'recorded', count: 1 }));
    expect(broker.canReport(RUN, NODE)).toBe(true);
  });

  it('gates per node, not per run', () => {
    const broker = new FindingsReportBroker();
    broker.register(RUN, NODE, async () => ({ status: 'recorded', count: 1 }));
    expect(broker.canReport(RUN, 'other-node')).toBe(false);
  });

  it('hands the report to the registered reporter and returns its outcome', async () => {
    const broker = new FindingsReportBroker();
    const reporter = vi
      .fn()
      .mockResolvedValue({ status: 'recorded', count: 1 });
    broker.register(RUN, NODE, reporter);

    await expect(broker.report(RUN, NODE, REPORT)).resolves.toEqual({
      status: 'recorded',
      count: 1,
    });
    expect(reporter).toHaveBeenCalledWith(REPORT);
  });

  it('answers unavailable — never throws — when no turn is running', async () => {
    const broker = new FindingsReportBroker();
    await expect(broker.report(RUN, NODE, REPORT)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no turn is running that could record them',
    });
  });

  it('answers unavailable when the reporter itself throws', async () => {
    // A throw here would cross the MCP transport as a tool error and read to
    // the model as its own call being malformed.
    const broker = new FindingsReportBroker();
    broker.register(RUN, NODE, async () => {
      throw new Error('the item could not be persisted');
    });

    await expect(broker.report(RUN, NODE, REPORT)).resolves.toEqual({
      status: 'unavailable',
      reason: 'the item could not be persisted',
    });
  });

  it('disposer removes the reporter it installed', () => {
    const broker = new FindingsReportBroker();
    const dispose = broker.register(RUN, NODE, async () => ({
      status: 'recorded',
      count: 1,
    }));
    dispose();
    expect(broker.canReport(RUN, NODE)).toBe(false);
  });

  it("a late disposer does NOT tear down the NEXT turn's reporter", async () => {
    // The whole reason register returns a disposer instead of exposing a keyed
    // unregister: settle paths run late and out of order, so turn 1's cleanup
    // routinely lands after turn 2 has already installed its own reporter.
    const broker = new FindingsReportBroker();
    const disposeFirst = broker.register(RUN, NODE, async () => ({
      status: 'recorded',
      count: 1,
    }));
    const second = vi.fn().mockResolvedValue({ status: 'recorded', count: 7 });
    broker.register(RUN, NODE, second);

    disposeFirst();

    expect(broker.canReport(RUN, NODE)).toBe(true);
    await expect(broker.report(RUN, NODE, REPORT)).resolves.toEqual({
      status: 'recorded',
      count: 7,
    });
    expect(second).toHaveBeenCalledOnce();
  });
});
