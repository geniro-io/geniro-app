/** What a model reads about `propose_patch`. */
export function proposePatchInstructions(): string {
  return (
    'Propose a change to ONE file without making it. The user sees the diff with Apply and Reject, and this ' +
    'app writes the file only if they accept. ' +
    'Use it when you have a concrete fix and would rather hand it over than edit directly — and do NOT also ' +
    'write the file yourself: if the user accepts, the change is already on disk. ' +
    'One file per call; call it again for the next one. ' +
    'The result tells you what happened, and the four outcomes mean different things: applied (it is on ' +
    'disk, do not write it again), rejected (do NOT route around it — ask what they would prefer), stale ' +
    '(they ACCEPTED but the file no longer matches, so re-read it and propose again — this is not a ' +
    'refusal), and unavailable (the card could not be shown at all, so describe the change in your reply ' +
    'instead).'
  );
}
