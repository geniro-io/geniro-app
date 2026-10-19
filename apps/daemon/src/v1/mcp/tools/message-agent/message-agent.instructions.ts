/** What a model reads about `message_agent`. */
export function messageAgentInstructions(): string {
  return (
    'Send a message INTO one of YOUR calls while its callee is still working on it — a correction, a changed requirement, context it is missing. ' +
    'Use it the moment you learn something that changes the callee’s current work, e.g. the user corrects what they asked for: do NOT hold the correction until the call finishes (the callee goes on building the thing the correction is about), and do NOT cancel_agent and re-dispatch (that throws away everything it already did right). ' +
    'The callee reads it inside the SAME turn and the call’s result still arrives through await_agent as usual. The receipt’s note says what the delivery cost: a callee whose CLI joins a message to its running turn reads it at its next tool boundary; one whose CLI interrupts instead stops the step in flight and continues from your message. ' +
    'A queued receipt means delivery is still pending. The transcript marks the final outcome as delivered or not delivered; if delivery fails, geniro tells you which message failed at your next turn. ' +
    'Not for a callee that PAUSED to ask you something — answer that with answer_agent. Not for a call that already finished — continue that conversation with call_agent and thread: <call_id>. ' +
    'Only calls you started yourself.'
  );
}
