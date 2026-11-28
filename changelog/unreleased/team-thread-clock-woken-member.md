### Fixed

- A team's header timer keeps counting while a member woken up inside a call it is still answering does its work, or while the next member of its pool takes the call over, and that time stays in the thread's total for Cursor and Codex members too
