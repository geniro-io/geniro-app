/** Shared lead — blocking and deferred listings differ only in how the call ends. */
const PROPOSE_PATCH_DESCRIPTION_LEAD =
  'Propose a change to ONE file without making it. The user sees the diff with Apply and Reject, and this ' +
  'app writes the file only if they accept. ' +
  'Use it when you have a concrete fix and would rather hand it over than edit directly — and do NOT also ' +
  'write the file yourself: if the user accepts, the change is already on disk. ' +
  'One file per call; call it again for the next one. ';

const PROPOSE_PATCH_DESCRIPTION_DEFERRED_MIDDLE =
  'The call returns at once — the card is on their screen, so STOP and end your turn. Do not write the file ' +
  'yourself, and do not call this again for the same change. What happened arrives as your next user message, ';

const PROPOSE_PATCH_DESCRIPTION_BLOCKING_MIDDLE =
  'The result tells you what happened, and ';

const PROPOSE_PATCH_DESCRIPTION_TAIL =
  'the four outcomes mean different things: applied (it is on ' +
  'disk, do not write it again), rejected (do NOT route around it — ask what they would prefer), stale ' +
  '(they ACCEPTED but the file no longer matches, so re-read it and propose again — this is not a ' +
  'refusal), and unavailable (the card could not be shown at all, so describe the change in your reply ' +
  'instead).';

/**
 * What a model reads about `propose_patch`.
 *
 * `answersAtOnce` is true when the CLI will not hold the call open for the
 * user's verdict (`PatchBroker.answersAtOnce`): the card is posted, the call
 * returns, and the verdict arrives later as a message — so the model has to be
 * told to stop rather than to wait on a call that would time out.
 */
export function proposePatchInstructions(answersAtOnce: boolean): string {
  if (answersAtOnce) {
    return (
      PROPOSE_PATCH_DESCRIPTION_LEAD +
      PROPOSE_PATCH_DESCRIPTION_DEFERRED_MIDDLE +
      'and ' +
      PROPOSE_PATCH_DESCRIPTION_TAIL
    );
  }
  return (
    PROPOSE_PATCH_DESCRIPTION_LEAD +
    PROPOSE_PATCH_DESCRIPTION_BLOCKING_MIDDLE +
    PROPOSE_PATCH_DESCRIPTION_TAIL
  );
}
