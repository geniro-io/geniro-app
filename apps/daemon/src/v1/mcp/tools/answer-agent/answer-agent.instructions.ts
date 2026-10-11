/** What a model reads about `answer_agent`. */
export function answerAgentInstructions(): string {
  return (
    'Answer a parked question one of YOUR callees raised (a {"status":"question"} envelope carrying its call_id). ' +
    'Answer from your own role/context only when confident; when unsure, ask the user through your own question mechanism first and relay their answer verbatim. ' +
    "After answering, collect the callee's final result with await_agent(call_id). Answer promptly: an unanswered question times out after a few minutes and fails the call."
  );
}
