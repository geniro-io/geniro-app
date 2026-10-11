/** What a model reads about `show_chart`. */
export function showChartInstructions(): string {
  return (
    'Plot numbers as a chart this app draws for the user. ' +
    'Use it when you have SEVERAL readings of one thing — a trend over time, or one quantity across ' +
    'categories — instead of writing them out as a table or an ASCII bar chart. ' +
    'Choose between this and show_metrics by what the numbers ARE: several readings of ONE thing is a ' +
    'chart; one current reading each of SEVERAL unrelated things (coverage, bundle size, test count) is a ' +
    'scorecard — they share no axis, so a chart of them is one huge bar and two invisible ones. ' +
    'Call it ONCE per chart, and do not also print the same numbers as text: the user sees the plot, so ' +
    'writing them out again shows the same data twice. Say what the chart shows in your reply; do not ' +
    'restate the figures. ' +
    'Every series holds one value per entry of `labels`, matched BY POSITION — the first value belongs to ' +
    'the first label, and so on. Use null for a point you did not measure; it is drawn as a gap. ' +
    'The result is a short receipt, never the numbers themselves.'
  );
}
