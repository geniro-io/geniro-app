import { act } from 'react';

const tick = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

/** A `StageGraph` draws after its lazy chunk and its ELK layout land; jsdom also lacks the DOMMatrix React Flow reads. */
export async function settleStageGraphs(
  scope: ParentNode = document,
): Promise<void> {
  (window as unknown as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??=
    class {
      m22 = 1;
    };
  for (let round = 0; round < 400; round += 1) {
    if (scope.querySelector('[data-slot="stage-graph-pending"]') === null) {
      break;
    }
    await tick();
  }
  for (let round = 0; round < 10; round += 1) {
    await tick();
  }
}
