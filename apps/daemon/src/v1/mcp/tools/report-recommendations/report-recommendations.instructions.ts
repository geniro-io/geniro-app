import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  MAX_RECOMMENDATIONS_PER_TARGET,
} from '../../../agents/chat.types';

/** What a model reads about `report_recommendations`. */
export function reportRecommendationsInstructions(
  memory: boolean,
  knowledge = false,
): string {
  return (
    "Post the analysis's recommendations as a card the user ticks and applies. " +
    `Use it when you have finished analysing the thread with ${HOST_ANALYZED_THREAD_TOOL}: call it ONCE with every recommendation, and do not also list them in your reply — the user sees the card. A refusal names every problem at once and keeps the card for the rest of this turn: send only \`patch\` with what fixes them (entries named by id, member or title, the fields sent replacing theirs; \`remove\` takes entries off), never the whole card again. Every check runs again on the result; a kept card is gone once a card is recorded or the turn ends. ` +
    `Each item needs evidence: seqs that exist in the analysed thread, each with a verbatim quote — in a team analysis, each also naming the \`runId\` it is from. At most ${MAX_RECOMMENDATIONS_PER_TARGET} items per target; an empty list is a valid report and means the thread ran efficiently. ` +
    "Each item's `impact` estimates what it changes per run — minutes and dollars saved (negative when it adds; dollars null when the runs report no cost) — and its `outcome`: the figure it moves, from what to what. `hotspots` say where the time and money went, costliest first, why, and which items address each; in a team analysis name the hotspot's member so the card draws that agent's measured figures beside it. The card itself shows the figures geniro measured over the analysed runs and projects them with the items the user ticks, so the call carries no totals of its own. " +
    `Ids are W-1, W-2… for team items (team threads and team analyses only), R-1, R-2… for repo items, U-1, U-2… for a user's own instruction file the read lists under \`userInstructions\`${memory ? ", M-1, M-2… for geniro's shared memory (kind add, update or forget)" : ''}${knowledge ? ', K-1, K-2… for a knowledge document (kind add, update or retire; `document` names its place and, for an existing one, its handle and rev; `change` is its whole text; `movesWith` names the other side of a move)' : ''}, X-1, X-2… for another repository (\`location\` is its absolute root folder on this Mac; applying it files a card on the user's board for a separate run there) and P-1, P-2… for the instructions of the project the analysed runs belong to (\`location\` is its projectId from view="project"; instructions only, never its description). ` +
    'Each item names its territory — process (how the agents work) or domain (what the work itself needs to know) — and keeps to it; split an item that needs both into two. ' +
    "In a team thread or team analysis, `members` assesses each member of the team that took a turn in the analysed runs: usefulness and quality, each 1–5 with cited rows (null when the runs give too little to judge), a summary with the figures behind them, and a verdict — keep, tune (role or instructions), reconfigure (model, effort or tools), replace or remove — whose W-, O- or P- items on this card carry it out (none for keep). The card draws the marks beside each member's measured figures, and the next analysis reads them back. A plain chat has no members: leave it out. " +
    `Do NOT use it for code-review defects — that is ${HOST_FINDINGS_TOOL}. Do not apply anything until the user presses Apply; afterwards record what happened with ${HOST_RECOMMENDATION_MARKS_TOOL}. ` +
    "The result is a short receipt naming the card's seq."
  );
}
