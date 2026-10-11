/** What a model reads about `cancel_agent`. */
export function cancelAgentInstructions(): string {
  return (
    'Stop one of YOUR open calls when finishing it is no longer worth anything. The callee settles as cancelled and you collect nothing further from it. ' +
    'Cancel when the call has become POINTLESS: the premise it was dispatched on has been refuted, the task was withdrawn or already done another way, or its own output shows it is building the wrong thing. ' +
    'Do NOT cancel a call merely because it is SLOW — a long callee turn is normal, and await_agent with timeout_ms lets you check in without committing to the wait. ' +
    'Do not cancel to re-dispatch the same work with a reworded message: that pays for the work twice — to correct or add to what the callee is doing, use message_agent instead. ' +
    'You may only cancel a call you started yourself. Whatever the callee had done is discarded, so say so to the user in the same turn, with the reason — this is spend they will see on the run.'
  );
}
