/** What a model reads about `remove_action`. */
export function removeActionInstructions(): string {
  return (
    'Take back a button you published with publish_action, by its `action_id`. ' +
    'Use it when the button no longer applies — the thing it waited for happened another way, or the ' +
    'plan changed. ' +
    'To change a button instead, publish it again with the same `action_id`. ' +
    'The result is a short receipt; an unknown id is answered with the ids you have live.'
  );
}
