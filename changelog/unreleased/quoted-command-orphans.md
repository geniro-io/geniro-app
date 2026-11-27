### Fixed

- After Geniro is force-quit or crashes, more of what an agent was running is stopped on the next launch instead of being left running: commands with quotes in them (like `perl -e 'sleep 300'`), multi-line commands and commands ending in a `#` comment from codex and cursor, and programs a command started on their own, such as a test browser
- Stopping one of an agent's background commands no longer risks stopping a different command that happens to run the same program
