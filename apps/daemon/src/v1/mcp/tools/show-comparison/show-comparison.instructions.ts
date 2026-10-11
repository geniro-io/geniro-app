/** What a model reads about `show_comparison`. */
export function showComparisonInstructions(): string {
  return (
    'Lay several options side by side against the same criteria, as a table this app draws, and say which ' +
    'one you would pick. ' +
    'Use it when you have been asked to choose between alternatives — libraries, designs, storage engines, ' +
    'approaches. ' +
    'Prefer it over writing a markdown table, but ONLY because of two things a table cannot carry, and only ' +
    'when you can supply them: a `verdict` on each cell, which is what lets the reader see at a glance which ' +
    'column wins, and a `recommendation` naming the option you would take and why. If every cell would be ' +
    'neutral and you have no recommendation, you have not compared anything — write a table instead. ' +
    'Every criterion holds one cell per entry of `options`, matched BY POSITION — the first cell is the ' +
    "first option's answer, and so on. " +
    'Call it ONCE, and do not also write the table out: the user sees it. The result is a short receipt.'
  );
}
