import {
  TEAM_NOTES_DEFAULT_LIMIT,
  TEAM_NOTES_MAX_LIMIT,
  TEAM_NOTES_REPLY_BUDGET_CHARS,
} from '../../../agents/chat.types';

/** What a model reads about `team_notes`. */
export function teamNotesInstructions(): string {
  return (
    "Read this team run's shared team notes — the contracts, decisions, facts, pitfalls and " +
    'pointers the agents of this run wrote with team_note. Use it when you start your work, before ' +
    'you change something other agents depend on (an interface, a shared file, an agreed ' +
    'decision), and whenever a reply says team notes are unread (`unread_team_notes`). Do not use ' +
    'it to wait for another agent or to pass it a message: notes reach no one by themselves — use ' +
    'call_agent or message_agent for that. Newest first; a note another one superseded is left out ' +
    "unless `include_superseded`. Narrow it by `kind`, by `author` (an agent's name), or by note " +
    `number with \`since\` / \`before\`. One reply holds at most \`limit\` notes (default ${TEAM_NOTES_DEFAULT_LIMIT}, ` +
    `at most ${TEAM_NOTES_MAX_LIMIT}) and about ${TEAM_NOTES_REPLY_BUDGET_CHARS.toLocaleString('en-US')} characters; when ` +
    'more remain it says how many and the `before` value that fetches the next older ones. After ' +
    'the app restarts, every note you did not write counts as unread again (a superseded one never does) until you read it.'
  );
}
