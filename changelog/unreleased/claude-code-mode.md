### New

- **Code mode for Claude Code:** a switch that lets Claude write one script that calls many tools at once

  Turn on Code mode wherever you pick a Claude Code model: a chat before its first message, a team member, a project's or a task's run settings, a saved run configuration, the command center or an analysis. Claude then batches tool calls into a single script instead of calling them one by one. It is off by default and experimental. It needs Claude Code 2.1.330 or later, a Claude 5.5 model or newer, and Anthropic's own API; where it cannot run, the switch says why. A conversation keeps the mode it started with: a chat refuses a model that cannot continue it, and a team member or task whose setting changes later picks it up in its next conversation.

### Improved

- A refused change to a chat's model settings now shows the reason instead of a raw error
- Claude Code's own warnings about Code mode now appear in the chat
