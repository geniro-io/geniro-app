import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  MAX_RECOMMENDATIONS_PER_TARGET,
} from '../../../agents/chat.types';

/** What a model reads about `report_recommendations`. */
export function reportRecommendationsInstructions(memory: boolean): string {
  return (
    "Post the analysis's recommendations as a card the user ticks and applies. " +
    `Use it when you have finished analysing the thread with ${HOST_ANALYZED_THREAD_TOOL}: call it ONCE with every recommendation, and do not also list them in your reply — the user sees the card. ` +
    `Each item needs evidence: seqs that exist in the analysed thread, each with a verbatim quote — in a workflow analysis, each also naming the \`runId\` it is from. At most ${MAX_RECOMMENDATIONS_PER_TARGET} items per target; an empty list is a valid report and means the thread ran efficiently. ` +
    "Each item's `impact` estimates what it changes per run — minutes and dollars saved (negative when it adds; dollars null when the runs report no cost) — and its `outcome`: the figure it moves, from what to what. `hotspots` say where the time and money went, costliest first, why, and which items address each; in a workflow analysis name the hotspot's node so the card draws that agent's measured figures beside it. The card itself shows the figures geniro measured over the analysed runs and projects them with the items the user ticks, so the call carries no totals of its own. " +
    `Ids are W-1, W-2… for workflow items (workflow threads and workflow analyses only), R-1, R-2… for repo items${memory ? ", U-1, U-2… for a user's own instruction file the read lists under `userInstructions` and M-1, M-2… for geniro's shared memory (kind add, update or forget)" : " and U-1, U-2… for a user's own instruction file the read lists under `userInstructions`"}. ` +
    'Each item names its territory — process (how the agents work) or domain (what the work itself needs to know) — and keeps to it; split an item that needs both into two. ' +
    `Do NOT use it for code-review defects — that is ${HOST_FINDINGS_TOOL}. Do not apply anything until the user presses Apply; afterwards record what happened with ${HOST_RECOMMENDATION_MARKS_TOOL}. ` +
    "The result is a short receipt naming the card's seq."
  );
}
