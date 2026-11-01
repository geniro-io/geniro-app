import {
  ACTION_COMMAND_TIMEOUT_DEFAULT_MINUTES,
  ACTION_COMMAND_TIMEOUT_MAX_MINUTES,
  ACTION_LIVE_MAX,
} from '../../../agents/chat.types';

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
    'Give `stop` instead of `message` for a button that stops a process you left running — a preview ' +
    'server, a watcher — once the user is done with it: `stop: {shell: "<id>"}` with the id your shell ' +
    'tool gave a command it runs in the background, or `stop: {pid: <n>}` for a process you started ' +
    'detached (`nohup <command> > <log> 2>&1 & echo $!` prints its pid). Only a process this chat ' +
    'started can be named, never your own process or its tool servers. A shell id whose command ' +
    'matches more than one running process is refused — name the pid then. A press stops the ' +
    'processes listed in the receipt and whatever they have started since; a stop button is always ' +
    'one-shot. ' +
    'Give `command` for a button that runs a command once the user confirms it — e.g. "Run the migration": ' +
    '`command: {argv: ["pnpm", "db:migrate"]}`. It runs without a shell (use `["/bin/sh", "-c", "<line>"]` ' +
    "for one), in this chat's folder unless you give `cwd`, and is stopped after `timeout_minutes` (default " +
    `${ACTION_COMMAND_TIMEOUT_DEFAULT_MINUTES}, at most ${ACTION_COMMAND_TIMEOUT_MAX_MINUTES}). The user sees ` +
    'its exact argv and folder before it runs; its exit code and the end of its output land in the chat. ' +
    'Set `notify_agent: true` to have them sent too, as a message, when it finishes (in a team, to the ' +
    "agent the user's messages go to). " +
    "In a team the press goes to the agent the user's messages go to — not back to you unless you " +
    'are that agent — prefixed with your name, and a call you are answering lists the button in its ' +
    'result; so word `message` for whoever reads it next. ' +
    'A button lasts until it is pressed (when `once`, the default), until you remove it with ' +
    'remove_action, or until the user dismisses it. Re-publishing the same `action_id` replaces it in ' +
    `place. A chat holds at most ${ACTION_LIVE_MAX} live actions. ` +
    'The result is a short receipt.'
  );
}
