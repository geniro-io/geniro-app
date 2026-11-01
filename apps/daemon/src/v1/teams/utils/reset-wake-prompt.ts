/**
 * What a caller is told when the window that stopped its calls reopens.
 *
 * Here rather than in the broker because it has two senders: the broker, which
 * delivers a promised continue through a live pass, and the executor, which
 * starts a pass to deliver one a daemon restart carried over — and the agent
 * must read the same words either way.
 */
export function resetWakePrompt(
  resetsAt: string,
  calls: readonly { callId: string; callee: string }[],
): string {
  const lines = [
    `[geniro] The usage limit that stopped these calls has reset (it said "resets ${resetsAt}"):`,
  ];
  for (const call of calls) {
    lines.push(
      '',
      `- ${call.callee} in ${call.callId}. Its conversation survives: continue it now with call_agent(agent: "${call.callee}", thread: "${call.callId}", message: ...) — say what was still left to do.`,
    );
  }
  return lines.join('\n');
}
