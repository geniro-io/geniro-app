---
description: geniro's own MCP tools — one module, one directory per tool, a shared base class and interface
paths:
  - "apps/daemon/src/v1/mcp/**"
  - "apps/daemon/src/v1/agents/utils/host-*.ts"
---

# geniro's MCP tools

## The one rule

**Every tool geniro's own MCP endpoint serves lives in `apps/daemon/src/v1/mcp/tools/`,
one directory per tool, laid out the same way, extending the shared base class.**
That covers editing an existing tool as much as adding a new one: a tool that
drifts out of the shape is a tool the next reader cannot find its parts in. These
are the "skills" geniro hands to agents — `call_agent`, `show_chart`,
`propose_plan`, `notify_user` and the rest. They are not the CLI's slash-command
skills (`SkillsService`), which this rule does not cover.

## The shape of one tool

`tools/<tool-name>/`, kebab-cased from the wire name (`show_chart` →
`show-chart/`), holds exactly these files:

| File | What it holds |
| --- | --- |
| `<tool>.tool.ts` | The class: its `name`, when it is offered, and what a call does. Logic only — no prose, no schema. |
| `<tool>.instructions.ts` | The description a model reads, as `export function <tool>Instructions(…): string`. The largest part of a tool and its routing logic, so it never sits inline in the class. |
| `<tool>.schema.ts` | The input JSON schema, field descriptions included, as `export function <tool>Schema(…): Record<string, unknown>`. A function, so every listing gets a fresh object. |
| `<tool>.reader.ts` | Reading the model's arguments (defensive, never throwing) and wording the result text. Its spec, `<tool>.reader.spec.ts`, sits beside it. |

Instructions and schemas are `.ts`, never `.md` or `.json`: swc compiles `.ts`
only and copies nothing into `dist/`, so any other file type silently fails to
reach a packaged daemon. A value the text needs (a cap, a callee roster, a wait
window) is a parameter of the function or an import, never a placeholder that
something has to fill in at load time.

## The base classes and the interface

- **`McpTool`** (`mcp.types.ts`) is the contract every entry meets: `handles`,
  `list`, `call`. `McpServerService` knows nothing else about a tool.
- **`BaseMcpTool`** (`tools/base-mcp-tool.ts`) is what a tool extends. Listing
  and dispatch are concrete there. A subclass fills `isOffered`, `instructions`,
  `inputSchema` and `run`, and answers through `this.text(…)` /
  `this.invalidArgs(…)` — never a hand-built result object. Never override
  `list` or `call`, or one tool comes to list itself in a shape the others do not.
- **`CallMcpTool`** (`tools/call-mcp-tool.ts`) is the base for a tool that is part
  of the agent-to-agent call runtime. It is offered only to a node with callees,
  answers with the broker's JSON envelope through `envelope(…)`, carries
  `ALWAYS_LOADED_TOOL_META`, and runs a wait through `waiting(…)`.
- **`HistoryMcpTool`** (`tools/history-mcp-tool.ts`) is the base for a tool that
  reads the saved chat history (`search_chats`, `read_chat_context`). It is
  offered to every holder, answers JSON behind `HISTORY_RESULT_PREFACE`, and
  parses its arguments strictly with nulls read as unset. These tools are NOT
  auto-approved and carry no `readOnlyHint` (codex skips approval for a
  read-only tool), so outside `auto` every call is a card.
- A tool that WAITS on a person (a card) runs that wait through
  `context.whileCancellable(…)`, so a client's `notifications/cancelled` reaches
  it. A tool that only draws does not.
- **The one exception is `tools/board/board.tools.ts`.** It serves the tasks
  module's board tools as one entry that implements `McpTool` directly, because
  the tasks module writes those tools and this module may not import it. Do not
  add a second exception: a tool geniro writes for this endpoint is a
  `BaseMcpTool`.

## Wiring a new tool

1. **Name it** as a constant in `agents/chat.types.ts` (`HOST_<NAME>_TOOL`) when
   anything outside `v1/mcp` must recognise it, which is every tool the chat's
   permission gate or the renderer has to know.
2. **The four files** above, with the class extending `BaseMcpTool` (or
   `CallMcpTool`).
3. **Register it** in `createMcpTools` (`tools/mcp-tools.ts`). This is the ONE
   place the `tools/list` order is written, and the order is part of what a model
   reads. A new dependency goes into `McpToolDeps` and the `MCP_TOOLS` factory in
   `mcp.module.ts`.
4. **Auto-approval**, when calling the tool is not itself a decision (a drawing,
   or a card whose own press is the gate): a predicate
   `isHost<Name>Call` in `agents/utils/host-<name>.ts` over the shared
   `isHostToolCall`, used by `ChatService`'s `autoApproves`. That predicate
   stays in `agents/utils`, never in the tool's directory, because `v1/agents`
   may not import `v1/mcp` (this module imports it). So does any reader the
   agents module itself needs (`readHostQuestions` for a deferred card). Only
   what the MCP endpoint alone uses moves into the tool's directory.
5. **The renderer**: a tool whose call row the transcript should hide goes in
   `GENIRO_TOOLS` (`apps/ui/src/renderer/chats/geniro-tool.ts`). That is a plain
   map the compiler cannot check, so it is easy to miss. A call tool also
   belongs in `GENIRO_MCP_CALL_TOOLS` (`agents/adapters/adapter.types.ts`).
6. **The description audit**: `mcp-server.service.spec.ts` (`McpServerService —
   what the descriptions tell a model`) reads the descriptions as a SET. A new
   tool that overlaps an existing one names that tool in its own instructions,
   and the other tool names it back. Every tool says WHEN to use it, and every
   card tool says when NOT to.

## Changing an existing tool

- Editing a tool's instructions or schema is a change to what every model reads.
  Keep the wording deliberate, and re-run the description audit.
- A refactor that is meant to change nothing must leave `tools/list` and the
  call results byte-identical. Prove it by capturing them before and after, not
  by reading the diff.
- Specs move with their file. A reader's tests live in `<tool>.reader.spec.ts`;
  behaviour across tools (listing, dispatch, cancellation) stays in
  `mcp-server.service.spec.ts`.
