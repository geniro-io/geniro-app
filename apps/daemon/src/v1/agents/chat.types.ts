import { z } from 'zod';

import {
  AgentKindSchema,
  ItemKindSchema,
  type RunStatus,
  RunStatusSchema,
} from '../runs/runs.types';

/**
 * The single-agent chat has exactly one node; its CLI session id is keyed
 * under this constant in `node_state` (whose PK is runId+nodeId). `Item.nodeId`
 * stays null for single-agent transcript rows, per the entity contract. Shared
 * with the terminals module, which resolves the same key to `--resume` the
 * chat's CLI session in a live TUI.
 */
export const SINGLE_AGENT_NODE = 'agent';

/**
 * Chat-level tool-approval modes. `plan` is chat-only by design decision —
 * the graph node schema stops at `acceptEdits` (graphs.types.ts
 * ApprovalModeSchema). A run row whose `approval` is null predates the mode
 * selector and keeps the legacy behavior: no permission flags on the CLI.
 */
export const CHAT_APPROVAL_MODES = [
  'auto',
  'ask',
  'acceptEdits',
  'plan',
] as const;
export const ChatApprovalModeSchema = z
  .enum(CHAT_APPROVAL_MODES)
  .meta({ id: 'ChatApprovalMode' });
export type ChatApprovalMode = z.infer<typeof ChatApprovalModeSchema>;

/**
 * What a new chat starts in when the user expresses no preference — a PRODUCT
 * choice (ask before acting), not a CLI fact, which is why it lives here and
 * not on an adapter. A CLI that cannot honour it falls back to the `auto`
 * floor; see `ChatService.initialApproval`.
 */
export const CHAT_DEFAULT_APPROVAL: ChatApprovalMode = 'ask';

/** One probed claude permission mode's headless support verdict. */
export const ProbeStatusSchema = z
  .enum(['pass', 'fail', 'unknown'])
  .meta({ id: 'ProbeStatus' });
export type ClaudeModeProbeStatus = z.infer<typeof ProbeStatusSchema>;

/**
 * The claude arm of GET /v1/capabilities — whether the installed claude CLI
 * accepts the probed `--permission-mode` values headlessly. Keyed by
 * `claude --version`: a binary upgrade re-probes without a daemon restart,
 * and only a genuine pass/fail verdict is disk-cached (`unknown` — timeout,
 * spawn error — stays memory-only).
 */
export const ClaudeModesCapabilitySchema = z
  .object({
    acceptEdits: ProbeStatusSchema,
    plan: ProbeStatusSchema,
    version: z
      .string()
      .nullable()
      .describe('`claude --version` line the verdict is keyed by'),
    probedAt: z
      .number()
      .nullable()
      .describe('Epoch ms of the probe that produced this verdict'),
    reason: z
      .string()
      .nullable()
      .describe('One-liner for the degrade system item / builder warning'),
  })
  .meta({ id: 'ClaudeModesCapability' });
export type ClaudeModesCapability = z.infer<typeof ClaudeModesCapabilitySchema>;

/**
 * Whether cursor-agent caller nodes can receive the call tools on THIS
 * machine — the cached verdict of the one-shot MCP-trust probe (headless
 * cursor-agent silently drops MCP servers it hasn't approved, so the only
 * honest answer comes from actually running one turn against an echo tool).
 * `unknown` = not probed yet this launch (no cursor caller ran, or the
 * binary version could not be read so the verdict is not disk-cacheable).
 */
export const CursorCallsCapabilitySchema = z
  .object({
    status: ProbeStatusSchema,
    version: z
      .string()
      .nullable()
      .describe('`cursor-agent --version` line the verdict is keyed by'),
    probedAt: z
      .number()
      .nullable()
      .describe('Epoch ms of the probe that produced this verdict'),
    reason: z
      .string()
      .nullable()
      .describe('One-liner for the builder warning when status is not pass'),
  })
  .meta({ id: 'CursorCallsCapability' });
export type CursorCallsCapability = z.infer<typeof CursorCallsCapabilitySchema>;

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/approval-card.tsx
 * MAX_ANSWER_LENGTH.
 *
 * Sanity cap on a question answer (M4) — it travels as ONE stdin control
 * line into the paused CLI turn. Enforced at BOTH ingress points of the
 * answer channel: the WS verdict (invalid/oversize → status:'invalid', request
 * remains pending) and the MCP answer_agent tool (oversize → INVALID_ARGS).
 */
export const MAX_ANSWER_LENGTH = 32_768;

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/approval-card.tsx
 * MAX_QUESTION_HEADER_LENGTH.
 *
 * Sanity cap on one question's `header` — the short noun phrase the CLI's own
 * picker uses as a tab title (claude documents 12 characters; this leaves room
 * for drift). A version-drifted payload could put a whole paragraph there, and
 * the renderer's tab strip has no truncation of its own, so an unbounded header
 * would push the answer controls off the card.
 */
export const MAX_QUESTION_HEADER_LENGTH = 64;

/**
 * Image types a pasted attachment may carry. Restricted to what the model APIs
 * behind both CLIs accept, so an unsupported paste is refused at the daemon
 * edge with a clear error rather than reaching an agent that silently ignores
 * it. Clipboard images from macOS screenshots are PNG.
 */
export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export const AttachmentMediaTypeSchema = z
  .enum(ATTACHMENT_MEDIA_TYPES)
  .meta({ id: 'AttachmentMediaType' });
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/use-attachments.ts.
 *
 * Per-image and per-message caps. A pasted screenshot is well under a
 * megabyte; the ceiling exists because the bytes ride one JSON body and are
 * then held in memory as base64 for the CLI payload, so an unbounded paste is
 * a daemon OOM. Enforced at the daemon edge — the renderer's matching cap is a
 * courtesy that keeps the user from composing a message that will be refused.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/**
 * One image attached to a user message. Only the METADATA lives in the item
 * payload (and therefore SQLite) — the bytes are a file under
 * `<userData>/attachments/<runId>/`, per the storage split: SQLite holds
 * runtime/history, not blobs. `id` is the file's basename, so the row is all
 * the attachment route needs to find the bytes again.
 */
export const AttachmentWireSchema = z
  .object({
    id: z.string(),
    mediaType: AttachmentMediaTypeSchema,
  })
  .meta({ id: 'AttachmentWire' });
export type AttachmentWire = z.infer<typeof AttachmentWireSchema>;

/** One image as it arrives on the send-message body: bytes, not yet stored. */
export interface SendMessageImage {
  mediaType: AttachmentMediaType;
  /** base64-encoded bytes. */
  data: string;
}

/** A stored attachment read back for display (base64 — see AttachmentDataDto). */
export interface AttachmentDataWire extends SendMessageImage {
  id: string;
}

/**
 * A persisted transcript item projected to the wire — `payload` is parsed back
 * from its stored JSON string so the renderer receives structured data, not a
 * doubly-encoded string. This is the shape the daemon emits over `/ws` and the
 * REST history read; the UI mirrors it in `shared/contracts.ts`.
 */
export const ItemWireSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string().nullable().describe('Graph node id; null for a chat'),
  seq: z
    .number()
    .int()
    .describe('Monotonic per-run sequence — the replay cursor'),
  kind: ItemKindSchema,
  role: z.string().nullable(),
  payload: z.unknown().describe('Kind-specific structured payload'),
  createdAt: z.string(),
});
export type ItemWire = z.infer<typeof ItemWireSchema>;

/**
 * One skill / slash command a CLI agent can be invoked with (`/name …` in the
 * message) in a given working directory — the rows of the composer's `/`
 * autocomplete. `kind` separates a skill directory
 * (`.claude/skills/<dir>/SKILL.md`) from a command file
 * (`.claude/commands/**.md`, `.cursor/commands/*.md`); `source` says where it
 * was discovered — the project folder, the user's home dir, or `cli`: the
 * claude session's own `system/init` report harvested on a prior turn in this
 * cwd (built-ins + plugin skills the disk scan can't see; always
 * `kind: 'command'`, no description). The UI mirrors this in
 * `shared/contracts.ts`.
 */
export const AgentSkillWireSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  kind: z
    .enum(['skill', 'command'])
    .describe('A skill directory (SKILL.md) vs a plain command file'),
  source: z
    .enum(['project', 'user', 'cli'])
    .describe('Where it was discovered — disk scan, or the CLI session itself'),
});
export type AgentSkillWire = z.infer<typeof AgentSkillWireSchema>;

/**
 * One model a CLI accepts for `--model`.
 *
 * `source` says where the row came from, because the two CLIs can answer very
 * differently: `cli` means the CLI itself reported it (cursor's `models`
 * subcommand, or the account models claude caches for its own picker), `builtin`
 * means the documented alias set we fall back to when the CLI cannot be asked —
 * an install too old for the subcommand, or one that is not signed in.
 */
// No `.meta({ id })` on this root: it backs an ARRAY response DTO, and an id
// there leaves the array pointing at a component that is never emitted (the
// boot guard in setupSwagger fails on exactly that dangling $ref).
export const AgentModelWireSchema = z.object({
  id: z.string().describe('Passed verbatim to the CLI as `--model <id>`'),
  label: z.string(),
  source: z
    .enum(['cli', 'builtin'])
    .describe('Reported by the CLI, or our documented fallback set'),
});
export type AgentModelWire = z.infer<typeof AgentModelWireSchema>;

/**
 * One MCP server a CLI agent loads in a working directory, with the health the
 * CLI itself reported for it.
 *
 * The set is per-CLI AND per-folder — a CLI resolves project-scoped servers
 * relative to where it runs — which is why the read is keyed on both and why
 * two agents in one thread legitimately show different lists.
 *
 * `status` carries `unknown` on purpose: for a CLI whose only listing is
 * human-readable prose, a reworded release must cost a health badge, never the
 * server row. `detail` is whatever the CLI printed after the status — the
 * failure reason, or what an unapproved server is waiting for — and is the
 * only actionable part of a failure.
 */
export const AgentMcpServerWireSchema = z
  .object({
    name: z.string(),
    target: z
      .string()
      .describe('The command line or URL the CLI reaches the server through'),
    transport: z.enum(['stdio', 'http', 'sse']),
    status: z
      .enum(['connected', 'failed', 'pending', 'unknown'])
      .describe(
        'Health as the CLI reported it; `pending` is a configured but unapproved server',
      ),
    detail: z
      .string()
      .nullable()
      .describe('The failure reason, or what the server is waiting for'),
  })
  .meta({ id: 'AgentMcpServer' });
export type AgentMcpServerWire = z.infer<typeof AgentMcpServerWireSchema>;

/**
 * One agent's MCP listing for one folder.
 *
 * An OBJECT rather than a bare array because an empty list is ambiguous on its
 * own, and resolving that ambiguity must not become a "which CLI is this?"
 * branch in the reader.
 *
 * `servers: []` with a NULL reason is the only shape that asserts anything
 * about the user's configuration — it means the folder genuinely has none.
 * A non-null reason means we are not asserting that, and it covers BOTH a CLI
 * that cannot be asked at all (`AdapterConfig.mcp.listingUnavailableReason`)
 * and a read that failed or could not be understood. The UI shows the sentence
 * verbatim rather than composing one, and today treats the two identically.
 *
 * A consumer that must tell a PERMANENT refusal from a TRANSIENT one — a
 * Retry affordance, or milestone 4 deciding whether cursor has gained a
 * listing — needs a discriminator added here rather than a match on the prose.
 * Deliberately not added yet: nothing reads it, and inventing the field now
 * would be a wire commitment with no consumer to shape it.
 */
// No `.meta({ id })` on this ROOT: it is the response DTO's own schema (see
// AgentModelWireSchema above for the dangling-$ref an id here would cause).
export const AgentMcpListingWireSchema = z.object({
  servers: z.array(AgentMcpServerWireSchema),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why this CLI cannot be listed at all; null when it can'),
});
export type AgentMcpListingWire = z.infer<typeof AgentMcpListingWireSchema>;

/**
 * One reasoning-effort level a CLI accepts for `--effort`.
 *
 * Opaque strings, never an enum on the wire: the vocabulary belongs to one
 * CLI (`AgentAdapter.listEfforts`), and pinning claude's six values into the
 * shared contract would put a CLI fact outside the adapter layer — and hand
 * the renderer a list it must never carry. An EMPTY array is the meaningful
 * answer for a CLI with no effort control; the composer omits the chip.
 */
// No `.meta({ id })` on this root: it backs an ARRAY response DTO (see
// AgentModelWireSchema above for the dangling-$ref this avoids).
export const AgentEffortWireSchema = z.object({
  id: z.string().describe('Passed verbatim to the CLI as `--effort <id>`'),
  label: z.string(),
});
export type AgentEffortWire = z.infer<typeof AgentEffortWireSchema>;

/**
 * Payload of an `unanswerable` item: one approval request whose turn settled
 * while it was still pending, so no verdict can ever reach it.
 *
 * `id` is the SAME request id the `approval_request` payload carries, which is
 * what lets the renderer close exactly that card.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/transcript-item.tsx` reads this
 * shape out of the item's `payload`. Item payloads are `z.unknown()` on the
 * wire BY DESIGN (each kind carries a different shape), so no generated type
 * spans the two sides — a change here MUST be mirrored there.
 */
export interface UnanswerableWire {
  id: string;
  toolName: string;
}

/** One persisted item, ready to fan out to its run's WS room (persist-then-emit). */
export interface RunItemEvent {
  runId: string;
  item: ItemWire;
}

/**
 * A run's status changed, broadcast to every client rather than to one room.
 *
 * TWIN PARSER: `apps/ui/src/renderer/daemon-client.ts` reads this shape off the
 * `run_status` Socket.IO event. Outside the generated HTTP contract (no route
 * carries it), so the two sides are independent implementations and a shape
 * change here MUST be mirrored there.
 *
 * `activity` is a short plain-English phrase naming what the run is doing
 * right now ("running Bash", "waiting for you"), or null when it is not doing
 * anything — a badge that says only "running" cannot distinguish an agent
 * working from one parked on a question nobody answered.
 */
export interface RunStatusEvent {
  runId: string;
  status: RunStatus;
  activity: string | null;
}

/**
 * The live text one agent has produced since its last DURABLE item — the
 * ephemeral plane behind a growing bubble.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/live-text.ts` reads this shape off
 * the `agent_delta` Socket.IO event. It is deliberately outside the generated
 * HTTP contract (no route carries it, so no OpenAPI schema exists), which is
 * why the two sides are independent implementations — a shape change here MUST
 * be mirrored there.
 *
 * `text` is the WHOLE tail, not an increment: a client that missed a delta is
 * correct again on the next one, and an empty string means "that block is
 * durable now, stop showing it". Nothing here is ever persisted or replayed.
 */
export interface RunDeltaEvent {
  runId: string;
  /** Owning graph node; null for a 1:1 chat's single agent. */
  nodeId: string | null;
  text: string;
  /**
   * Reasoning tokens spent so far this turn, or null when the agent is not
   * (or no longer) thinking.
   *
   * Rides the SAME event as the text tail rather than a second channel: both
   * answer "what is this agent doing right now", both are ephemeral, and one
   * mechanism cannot get out of sync with itself. There is no reasoning TEXT
   * to carry — headless claude redacts it — so a running total is the whole
   * signal.
   *
   * CUMULATIVE OVER THE TURN, not over one reasoning stretch: the CLI restarts
   * its own count each time the agent breaks off to write, which made the
   * number appear to reset mid-turn.
   */
  thinkingTokens: number | null;
  /**
   * Epoch ms when this turn's FIRST reasoning began, or null when the agent is
   * not reasoning right now.
   *
   * A timestamp rather than an elapsed number so the client owns the clock: a
   * duration computed here would be frozen at publish time and would need a
   * delta per second to keep ticking.
   */
  thinkingSince: number | null;
  /**
   * Prompt-side tokens as of the turn's most recent request — how full the
   * window is RIGHT NOW.
   *
   * Mid-turn, unlike the `turn_complete` payload the meter used to be limited
   * to. Null before the turn's first `assistant` line, or for a CLI that
   * reports no per-request usage.
   */
  contextTokens: number | null;
  /**
   * The window `contextTokens` is measured against, as last reported for this
   * run. Remembered across turns because it rides the `result` line only, so a
   * turn's first request has none of its own. Null until a turn has completed.
   */
  contextWindowTokens: number | null;
}

/** A run projected to the wire (chat and workflow runs share the shape). */
export const RunWireSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  title: z.string().nullable(),
  agentKind: AgentKindSchema.nullable(),
  workflowId: z
    .string()
    .nullable()
    .describe('Workflow slug for a graph run; null for a single-agent chat'),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  approval: ChatApprovalModeSchema.nullable().describe(
    'Chat approval mode; null = legacy row (no permission flags, pre-selector)',
  ),
  effort: z
    .string()
    .nullable()
    .describe(
      "Reasoning-effort level for the next turn, in the CLI's own vocabulary; null = the CLI's default (no --effort flag)",
    ),
  createdAt: z.string(),
  /**
   * Last write to the run row — every send flips status to `running` and every
   * settle writes the terminal status, so this is the run's last-activity time.
   */
  updatedAt: z.string().describe("The run's last-activity time"),
  /**
   * Text of the run's latest `message` item (the chat list's preview line).
   * Null when the run has no messages yet; list endpoints enrich it, while
   * create paths return null (a fresh run genuinely has none).
   */
  lastMessage: z
    .string()
    .nullable()
    .describe("Text of the run's latest message item — the list preview line"),
});
export type RunWire = z.infer<typeof RunWireSchema>;
