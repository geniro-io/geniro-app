/** What a model reads about `memory_save`. */
export function memorySaveInstructions(): string {
  return (
    'Save one durable fact to the memory every agent shares, or update an entry in place. Use it ' +
    'when you learn something the next agent — on any CLI, in any later chat — would otherwise have ' +
    'to rediscover or could get wrong: a preference or correction the user gave, a project ' +
    'convention or decision and its reason, a command that works, where something lives. One fact ' +
    'per entry, written to stand alone. Search with memory_search first: when an entry already ' +
    'covers it, update that entry (its id and the rev you read) rather than adding another; a save ' +
    'that looks like an existing entry is refused and names it. Do NOT save credentials, tokens or ' +
    'anything secret; progress reports or what you are doing right now; anything the code, the ' +
    "repository's AGENTS.md or the task already says; or guesses you have not verified. When the " +
    'user reviews agent writes, a new entry waits for that review before any agent sees it, and ' +
    'updating an existing entry is refused — tell the user what should change instead.'
  );
}
