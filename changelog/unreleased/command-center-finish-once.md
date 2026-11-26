### Fixed

- The command center manager announces a thread's finish once: a finished thread that runs again without new work no longer brings a second Done card or wakes the manager again.
- A thread that still runs a monitor now counts as working on the command center and is announced only once its monitors end.
- Asking the manager to tell you when a thread finishes now covers that one finish; it no longer keeps waking the manager for every later finish of that thread.
- A watched thread that finishes while Geniro is closed or restarting is now announced to the manager once at the next start, instead of never.
