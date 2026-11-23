/** What a model reads about `show_chart`. */
export function showChartInstructions(): string {
  return (
    'Plot numbers as a chart this app draws for the user. ' +
    'Use it whenever you have SEVERAL readings of one thing and would otherwise write them as a markdown ' +
    'table or an ASCII bar chart: a figure over time (spend by month, a timing per release, errors per day) ' +
    'or a total split across categories (a monthly bill by service, hours by phase, files by language). ' +
    'A table of such numbers is the signal to call this instead. ' +
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
