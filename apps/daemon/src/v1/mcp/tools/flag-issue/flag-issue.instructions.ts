/** What a model reads about `flag_issue`. */
export function flagIssueInstructions(): string {
  return (
    'Record a problem that went wrong in this thread, so an analysis reads it instead of the whole ' +
    'dialogue. Call it only for something important: a problem that cost real work (`cost: work`, ' +
    'with `minutesLost`) — a geniro tool that failed or behaved unexpectedly, an instruction that ' +
    'misled you, a wrong memory entry — or the user disagreeing with what you did or proposed ' +
    '(`cost: disagreement`). `category` says where the cause lies: `geniro_tool`, ' +
    "`geniro_instructions` (geniro's system instructions), `user_instructions` (the user's own " +
    'instructions to agents), `memory`, or `other`. `summary` is one sentence of what went wrong; ' +
    '`detail` may add what you tried and what worked. Never flag an ordinary error you fixed in one ' +
    'step, an expected failure (a test you were fixing, a missing file you then created), or a style ' +
    'preference. At most 10 per conversation; the same summary twice in a thread is refused. Nothing ' +
    'waits on this call and nobody is told about it; it never replaces your reply. A wrong memory ' +
    'entry is still marked with memory_feedback, and in a team a team note (team_note) is still how ' +
    'to warn the other agents.'
  );
}
