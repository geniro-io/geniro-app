import { z } from 'zod';

import {
  AgentKindSchema,
  ItemKindSchema,
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

/** One probed claude permission mode's headless support verdict. */
export const ProbeStatusSchema = z
  .enum(['pass', 'fail', 'unknown'])
  .meta({ id: 'ProbeStatus' });
export type ClaudeModeProbeStatus = z.infer<typeof ProbeStatusSchema>;

/**
 * The claude arm of GET /v1/capabilities — whether the installed claude CLI
 * accepts the probed `--permission-mode` values headlessly. Keyed by
 * `claude --version` like the cursor MCP-trust probe: a binary upgrade
 * re-probes without a daemon restart, and only a genuine pass/fail verdict is
 * disk-cached (`unknown` — timeout, spawn error — stays memory-only).
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

/** One persisted item, ready to fan out to its run's WS room (persist-then-emit). */
export interface RunItemEvent {
  runId: string;
  item: ItemWire;
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
   */
  thinkingTokens: number | null;
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
