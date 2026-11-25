/** What a model reads about `save_plugin`. */
export function savePluginInstructions(answersAtOnce: boolean): string {
  return (
    'Make or change a Geniro Plugin — a block in the right panel of this app’s chats that runs a shell command in the chat’s folder and draws its JSON output; it is NOT a Claude Code, cursor or codex plugin. ' +
    'Use it when the user asks for a block, panel or widget that shows something live, such as the last prod deploys or open incidents. ' +
    'First run the command yourself and check it prints JSON; pass what it printed as `sample`, which the card previews. ' +
    'Pass `name`; `command` — ONE shell line run with /bin/sh -c in the chat’s folder that prints JSON to stdout (30 s timeout by default, 1 MB at most); ' +
    '`view` — A2UI v1.0 basic-catalog components (show_ui’s vocabulary), one with id "root", bound to the output with {"@path": "/data/…"} where /data is the parsed output, List templates over arrays included; links are a Button whose functionCall is openUrl, and only http(s) links open. ' +
    'No input components (TextField, CheckBox, ChoicePicker, Slider, DateTimeInput) and no Modal. ' +
    'Optional `buttons` — {id, command, confirm, env}, pressed by a view Button with action {"event": {"name": "<id>"}}: a button’s command receives data ONLY as environment variables named PLUGIN_*, each mapped to a JSON pointer into the data in `env` — never put data into a command line — and set confirm: true on every button that deploys, deletes, writes or costs money (unmarked buttons run at once on a press). ' +
    '`folders` — absolute folders the block shows in, subfolders included; leave it out for this chat’s folder, [] for every folder. `refresh_minutes` defaults to 5. ' +
    'To change a plugin, pass its `slug`; the card shows what changes. ' +
    (answersAtOnce
      ? 'A plugin that passes is put on a card showing its command, folders and buttons, and this call returns at once: END YOUR TURN, and the user’s Approve or Reject arrives as your next message. '
      : 'A plugin that passes is put on a card showing its command, folders and buttons, and this call waits until the user presses Approve or Reject; nothing is saved without Approve. ') +
    'Create and change plugins ONLY through this tool — never write files under Geniro’s plugins folder yourself. Deleting a plugin is the user’s, in Settings → Plugins. Do NOT use it for a one-off answer the user will read once — show_metrics or show_ui draw that in your reply.'
  );
}
