import { ACTION_LIVE_MAX } from '../../../agents/chat.types';

/** What a model reads about `publish_action`. */
export function publishActionInstructions(): string {
  return (
    'Put a button in this chat that the user can press later — on the composer shelf and as a card ' +
    'in the transcript. Pressing a message action sends its `message` into this chat as if the user ' +
    'had typed it, so you pick up from there. ' +
    'Use it when the next step waits on something only the user will see happen — "PR merged", ' +
    '"Deploy approved", "Design signed off" — so they can tell you with one press instead of typing. ' +
    'Do not use it to ask a question you need answered now (use your question tool), nor for a ' +
    'button the user would press right away. ' +
    'Write `message` as the instruction you want to receive, e.g. "The PR is merged — clean up the ' +
    'branch and close the card." ' +
    'A button lasts until it is pressed (when `once`, the default), until you remove it with ' +
    'remove_action, or until the user dismisses it. Re-publishing the same `action_id` replaces it in ' +
    `place. A chat holds at most ${ACTION_LIVE_MAX} live actions. ` +
    'The result is a short receipt.'
  );
}
