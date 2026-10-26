import { describe, expect, it } from 'vitest';

import { PatchBroker } from './patch.broker';
import { PlanBroker } from './plan.broker';

describe('HostSinkBroker answersAtOnce', () => {
  const RUN = 'run-1';
  const NODE = 'agent';

  it.each([
    ['PlanBroker', () => new PlanBroker()],
    ['PatchBroker', () => new PatchBroker()],
  ])(
    '%s keeps the flag with the sink and drops it on dispose',
    (_name, make) => {
      const broker = make();
      const dispose = broker.register(
        RUN,
        NODE,
        async () => ({ status: 'posted' }) as const,
        { answersAtOnce: true },
      );

      expect(broker.answersAtOnce(RUN, NODE)).toBe(true);
      dispose();
      expect(broker.answersAtOnce(RUN, NODE)).toBe(false);
    },
  );

  it('defaults to a call that is held open', () => {
    const broker = new PlanBroker();
    broker.register(RUN, NODE, async () => ({ status: 'posted' }));

    expect(broker.answersAtOnce(RUN, NODE)).toBe(false);
  });

  it('never lends one turn’s flag to the next, whatever order the disposers run in', () => {
    // A late settle of the deferring turn must neither clear the next turn's
    // own flag nor leave its own behind for that turn to inherit.
    const broker = new PatchBroker();
    const sink = async (): Promise<{ status: 'posted' }> => ({
      status: 'posted',
    });
    const disposeDeferring = broker.register(RUN, NODE, sink, {
      answersAtOnce: true,
    });
    const disposeHolding = broker.register(RUN, NODE, sink);

    expect(broker.answersAtOnce(RUN, NODE)).toBe(false);
    disposeDeferring();
    expect(broker.canPropose(RUN, NODE)).toBe(true);

    broker.register(RUN, NODE, sink, { answersAtOnce: true });
    disposeHolding();
    expect(broker.answersAtOnce(RUN, NODE)).toBe(true);
  });
});
