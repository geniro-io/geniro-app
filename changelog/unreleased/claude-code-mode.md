### New

- **Code mode for Claude Code chats:** a per-chat switch that lets Claude write one script that calls many tools at once

  Turn on Code mode in a Claude Code chat's model settings before you send the first message. Claude then batches tool calls into a single script instead of calling them one by one. It is off by default and experimental. It needs Claude Code 2.1.330 or later, a Claude 5.5 model or newer, and Anthropic's own API; where it cannot run, the switch says why. Once the chat has started, Code mode stays as it was for that conversation, and a model that cannot continue it is refused.

### Improved

- A refused change to a chat's model settings now shows the reason instead of a raw error
- Claude Code's own warnings about Code mode now appear in the chat
