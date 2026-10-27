/** What a model reads about `record_outcome`. */
export function recordOutcomeInstructions(): string {
  return (
    'Record where one pull request of this workflow run stands — a structured record geniro keeps ' +
    'with the run, shows on it, and counts per workflow version. Use it when your role says to, ' +
    'typically each time you have read a delivery report on a pull request and again after the user ' +
    'answers whether they accept it. One call per pull request; a later call for the same pull ' +
    'request replaces its earlier outcome, so send every field each time. `review_rounds` counts the ' +
    "reviews of the pull request run after it was built; `acceptance` is the user's verdict: " +
    '`accepted`, `changes_requested`, `not_yet`, or `not_needed` when the pull request needs no ' +
    'acceptance. Give `summary` a sentence or three a person can read on the outcome — what the ' +
    'change does and, unless it was accepted, what the user asked to change or what is still open. ' +
    'geniro counts the questions put to the user itself — do not report them. Nothing ' +
    'waits on this call and nobody is told about it; it never replaces reporting to whoever called ' +
    'you, a team note (team_note) is still where to tell other agents something, and a run with ' +
    'stages moves them with move_stage.'
  );
}
