/** What a model reads about `report_findings`. */
export function reportFindingsInstructions(): string {
  return (
    'Report code-review findings as a typed list so this app draws them for the user. ' +
    'Use it when you have reviewed code and have concrete defects to hand back — call it ONCE with every ' +
    'finding, most-severe first, and do not also print the findings as text: the user sees the rendered ' +
    'list, so writing them out again shows the same findings twice. ' +
    'Do NOT use it for a single problem you found while doing something else, or to narrate work in ' +
    'progress — a one-row review card says less than the sentence it replaces. ' +
    'If you also have a tool of your own named ReportFindings, this is the same job and takes the same ' +
    'arguments; prefer THIS one, because only this one draws the findings in the app the user is looking at. ' +
    'An empty array is a valid report and means nothing survived your verification. ' +
    'When you later fix findings you already reported, report them again with `outcome` set on each. ' +
    'The result is a short receipt, never the findings themselves.'
  );
}
