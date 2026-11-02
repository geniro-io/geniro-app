/** What a model reads about `record_outcome`. */
export function recordOutcomeInstructions(): string {
  return (
    'Record how this thread ended, or where one pull request of it stands — a structured record ' +
    'geniro keeps with the run, shows on it, and counts in its statistics. Use it when a task ' +
    'ends, and when a pull request you opened moves. Two kinds of call. ' +
    'A thread outcome: `outcome` (`success`, `partial`, `failed` or `abandoned`) and a `summary` ' +
    'of what was done and what is left, once at the very end of a task, or when the user calls it ' +
    'off; a later call replaces it. Without one, geniro derives the outcome from how the goals ' +
    'closed (see goals), so record it when the goals do not tell the whole story. ' +
    'A pull request outcome: `pr_number`, `pr_url`, `draft`, `review_rounds` and `acceptance`, ' +
    'only when something changed: the draft state, the review rounds or the acceptance. A call ' +
    'repeating the newest outcome of that pull request writes nothing and answers "Unchanged". One ' +
    'call per pull request; a later call for the same pull request replaces its earlier outcome, so ' +
    'send every field each time. `review_rounds` counts the ' +
    "reviews of the pull request run after it was built; `acceptance` is the user's verdict: " +
    '`accepted`, `changes_requested`, `not_yet`, or `not_needed` when the pull request needs no ' +
    'acceptance. Give `summary` a sentence or three a person can read on the outcome — what the ' +
    'change does and, unless it was accepted, what the user asked to change or what is still open. ' +
    'geniro counts the questions put to the user itself — do not report them. Nothing ' +
    'waits on this call and nobody is told about it; it never replaces your reply, and it never ' +
    'replaces reporting to whoever called you; in a team a team note (team_note) is still where to tell other agents ' +
    'something, and a run with stages moves them with move_stage.'
  );
}
