### Fixed

- After Geniro is force-quit or crashes, a command an agent was running that has quotes in it (like `perl -e 'sleep 300'`) is stopped on the next launch instead of being left running
