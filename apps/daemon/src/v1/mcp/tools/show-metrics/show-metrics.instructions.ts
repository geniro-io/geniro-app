/** What a model reads about `show_metrics`. */
export function showMetricsInstructions(): string {
  return (
    'Show a few headline figures as a scorecard this app draws for the user. ' +
    'Use it when you have measured a handful of separate things worth seeing at a glance — coverage, bundle ' +
    'size, test count, a timing, a spend — instead of writing them into a sentence the reader has to pick ' +
    'apart. ' +
    'Choose between this and show_chart by what the numbers ARE: several readings of ONE thing over time or ' +
    'across categories is a chart; one current reading each of SEVERAL unrelated things is this. They share ' +
    'no axis, so a chart of them is one huge bar and two invisible ones. ' +
    'Every figure must arrive ALREADY FORMATTED, as a string — "82%", "1.2 MB", "4m 12s" — because only you ' +
    'know how it should read; this app displays it and never reformats. ' +
    'Call it ONCE, and do not also write the numbers out: the user sees them. Say what they MEAN in your ' +
    'reply. The result is a short receipt, never the figures.'
  );
}
