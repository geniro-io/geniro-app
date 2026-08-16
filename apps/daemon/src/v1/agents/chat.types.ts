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
 * Ceiling on an image an agent referenced from its own markdown
 * ({@link LocalImageService}).
 *
 * Separate from {@link MAX_ATTACHMENT_BYTES} and larger, because the two bound
 * different risks. That one caps what a user PASTES into a message the daemon
 * must hold in memory as base64 and hand to a CLI; this one caps what the
 * renderer will draw, and the file is one the agent produced — a full-window
 * screenshot at 2x comfortably exceeds 5MB, and refusing to display it would
 * be the same broken image by another route.
 */
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** One markdown-referenced image, read off disk for display. */
export const LocalImageWireSchema = z.object({
  path: z
    .string()
    .describe(
      'the reference exactly as the agent wrote it — the renderer’s cache key',
    ),
  mediaType: AttachmentMediaTypeSchema,
  data: z.string().describe('base64-encoded image bytes'),
});
// No `.meta({ id })`: this is a response DTO ROOT — same rule, and same reason,
// as `ChatMetricsWireSchema` below.
export type LocalImageWire = z.infer<typeof LocalImageWireSchema>;

/**
 * One line item of the context window — a NAMED component, so the generated
 * client gets a real type rather than an inline anonymous shape per field.
 */
const ContextCategorySchema = z
  .object({
    name: z.string().describe("the CLI's own name for this part of the window"),
    tokens: z.number(),
    deferred: z
      .boolean()
      .describe(
        'available but not loaded, and so NOT counted in totalTokens — rendering it in the same bar reports a window several times fuller than it is',
      ),
  })
  .meta({ id: 'ContextCategory' });

const ContextMemoryFileSchema = z
  .object({
    path: z.string(),
    kind: z
      .string()
      .nullable()
      .describe(
        "the CLI's own word for where it came from (Project, AutoMem…)",
      ),
    tokens: z.number(),
  })
  .meta({ id: 'ContextMemoryFile' });

const ContextServerSchema = z
  .object({
    name: z.string(),
    tokens: z.number().describe("this server's whole tool surface, summed"),
    toolCount: z.number(),
    loadedToolCount: z
      .number()
      .describe('how many of them are actually in the window right now'),
  })
  .meta({ id: 'ContextServer' });

/** The context window's contents, as the agent's own CLI accounts for them. */
export const ContextBreakdownWireSchema = z
  .object({
    categories: z.array(ContextCategorySchema),
    totalTokens: z.number().nullable(),
    maxTokens: z.number().nullable(),
    model: z.string().nullable(),
    autoCompactAtTokens: z
      .number()
      .nullable()
      .describe('where this CLI would compact the conversation by itself'),
    autoCompactEnabled: z.boolean().nullable(),
    memoryFiles: z.array(ContextMemoryFileSchema),
    servers: z.array(ContextServerSchema),
  })
  .meta({ id: 'ContextBreakdown' });
export type ContextBreakdownWire = z.infer<typeof ContextBreakdownWireSchema>;

/**
 * What the whole thread has spent, summed over its finished turns.
 *
 * Summed on the DAEMON rather than in the renderer, though the renderer holds
 * the same items: a chat's history is paged behind an `afterSeq` cursor, so a
 * client that has only scrolled back through part of it would total part of
 * it — and silently, since a smaller number looks exactly like a cheaper
 * conversation.
 */
export const ChatTotalsWireSchema = z
  .object({
    turns: z.number().describe('turns that reported usage'),
    costUsd: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(),
    cacheCreationTokens: z.number().nullable(),
    thinkingTokens: z.number().nullable(),
    workedMs: z
      .number()
      .nullable()
      .describe("the CLI's own working time, where it reported one"),
  })
  .meta({ id: 'ChatTotals' });
export type ChatTotalsWire = z.infer<typeof ChatTotalsWireSchema>;

/**
 * What one chat's context window holds right now, plus what the whole thread
 * has cost — the readout behind the composer's context ring.
 *
 * Two halves with two different sources, deliberately answered by ONE route so
 * the panel cannot show a breakdown from one moment beside a spend from
 * another. The breakdown is ASKED of the live CLI process, so it exists only
 * while the run holds one; the totals are summed from the thread's own
 * persisted turns and are always there.
 */
export const ChatMetricsWireSchema = z.object({
  context: ContextBreakdownWireSchema.nullable(),
  breakdownReason: z
    .string()
    .nullable()
    .describe(
      'why there is no breakdown — a CLI without the channel, or a chat with no running agent to ask',
    ),
  totals: ChatTotalsWireSchema,
});
// No `.meta({ id })` on this one: it is a RESPONSE DTO ROOT, and nestjs-zod
// would then register the component under the id while the route still points
// at the DTO class name — the dangling `$ref` `setupSwagger` fails the boot on.
// The nested shapes above carry ids precisely because they are not roots.
export type ChatMetricsWire = z.infer<typeof ChatMetricsWireSchema>;

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
 *
 * `target` and `transport` are nullable because not every CLI reports them:
 * claude prints the server's command line, cursor prints only a name and a
 * status. Null says "this CLI did not tell us", which an empty string could
 * not — it would have claimed a command exists and silently blanked the row's
 * tooltip instead.
 */
export const AgentMcpServerWireSchema = z
  .object({
    name: z.string(),
    target: z
      .string()
      .nullable()
      .describe(
        'The command line or URL the CLI reaches the server through, or null when the CLI does not report one',
      ),
    transport: z
      .enum(['stdio', 'http', 'sse'])
      .nullable()
      .describe('Null when the CLI does not report one'),
    status: z
      .enum([
        'connected',
        'failed',
        'pending',
        'disabled',
        'needs_auth',
        'unknown',
      ])
      .describe(
        'Health as the CLI reported it; `pending` is a configured but unapproved server, `disabled` one switched off in the CLI’s own config, `needs_auth` an OAuth server nobody has signed in to yet',
      ),
    detail: z
      .string()
      .nullable()
      .describe('The failure reason, or what the server is waiting for'),
    scope: z
      .enum(['project', 'other', 'unknown'])
      .describe(
        'Where the server is defined; only `project` has any verified disable mechanism',
      ),
    disabled: z
      .boolean()
      .describe(
        'Whether the next turn will leave this server out, whoever switched it off',
      ),
    toggleUnavailableReason: z
      .string()
      .nullable()
      .describe(
        'Why this row carries no switch, or null when it does. A sentence, so the UI never has to derive one from `scope`',
      ),
    signInUnavailableReason: z
      .string()
      .nullable()
      .describe(
        'Why this row offers no sign-in, or null when it does. Answered for EVERY row, not just `needs_auth` ones, so the UI never infers a capability from a status',
      ),
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
 *
 * `pending` is the THIRD shape, and the reason it had to exist: a cold read
 * dials every server the folder defines, which is measured in seconds and
 * bounded only by the slowest one. Blocking the response on that made the panel
 * hold an HTTP request open for up to the CLI's whole listing timeout. So a
 * cold read now answers immediately with `pending: true` and empty rows, and
 * the dial continues behind it — meaning `servers: []` asserts "this folder has
 * none" only when `pending` is false. A consumer that ignores the flag would
 * read a read-in-progress as an empty folder.
 */
// No `.meta({ id })` on this ROOT: it is the response DTO's own schema (see
// AgentModelWireSchema above for the dangling-$ref an id here would cause).
export const AgentMcpListingWireSchema = z
  .object({
    servers: z.array(AgentMcpServerWireSchema),
    unavailableReason: z
      .string()
      .nullable()
      .describe('Why this CLI cannot be listed at all; null when it can'),
    pending: z
      .boolean()
      .describe(
        'A cold read is running; these rows are not the answer yet. Ask again.',
      ),
    interactiveOnlyNote: z
      .string()
      .nullable()
      .describe(
        "What this CLI loads only in its OWN interactive session, so the panel's completeness is not mistaken for lost rows; null when there is no such gap",
      ),
  })
  // Three fields, but only three LEGAL states — reading, refused, answered. The
  // combinations below are representable and mean nothing, and every consumer
  // was guarding against them by hand (each construction site spells
  // `pending: false`). One missed guard renders a read-in-progress as "No
  // servers", a claim about the user's configuration that nobody made.
  //
  // Enforced on the RESPONSE, which is where it bites: `@ZodResponse`
  // serializes through this schema, so a daemon that ever composed an illegal
  // envelope fails here rather than shipping it to a renderer that has to
  // re-derive which field wins.
  .refine(
    (listing) =>
      !listing.pending ||
      (listing.unavailableReason === null && listing.servers.length === 0),
    'a pending listing carries no rows and no reason — it is the answer not being ready yet',
  );
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
  /**
   * Whether this run is parked on the USER, and on what — or `undefined` when
   * this event says nothing about it.
   *
   * Three states, deliberately: `undefined` (absent on the wire) asserts
   * nothing and leaves the client's reading alone, `null` says the run is no
   * longer parked, and a kind says it is. The same distinction `status` below
   * draws, for the same reason — only the two transitions (a card opening, a
   * card closing) know anything about this, and every other announce must not
   * overwrite what they said.
   *
   * It exists because "parked on you" was knowable ONLY for the chat in focus:
   * the renderer derived it from that run's transcript items, which are the one
   * thing a background run does not stream. So a run waiting on an answer went
   * on showing a spinner in the sidebar for as long as the user was looking
   * somewhere else — the one state where a spinner is actively misleading,
   * since nothing will move until they come back.
   */
  awaiting?: RunAwaiting | null;
  /**
   * The run's new status, or null when this event only says what the run is
   * DOING and asserts nothing about whether it is still going.
   *
   * The distinction is load-bearing. The activity announce fires from inside a
   * turn's event stream — on every tool call — and it never reads the run's
   * status, so while it published a hardcoded `'running'` the client wrote that
   * back onto the row: one straggler event arriving after a cancel or a
   * terminal write flipped the run to "running", and nothing announced again to
   * correct it. A status this event never read is not one it may assert, so it
   * sends null and the client leaves the badge alone.
   */
  status: RunStatus | null;
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
   * Reasoning tokens spent in the CURRENT stretch, or null when the agent is
   * not (or no longer) thinking.
   *
   * Rides the SAME event as the text tail rather than a second channel: both
   * answer "what is this agent doing right now", both are ephemeral, and one
   * mechanism cannot get out of sync with itself. There is no reasoning TEXT
   * to carry — headless claude redacts it — so a running total is the whole
   * signal.
   *
   * PER STRETCH, not cumulative over the turn: a turn that thinks, runs tools,
   * then thinks again is two separate waits, and each is shown as its own row
   * with its own count. A turn total spanning them read as one endless
   * "thinking" whose number never went back to zero.
   */
  thinkingTokens: number | null;
  /**
   * Epoch ms when the CURRENT reasoning stretch began, or null when the agent
   * is not reasoning right now.
   *
   * A timestamp rather than an elapsed number so the client owns the clock: a
   * duration computed here would be frozen at publish time and would need a
   * delta per second to keep ticking.
   */
  thinkingSince: number | null;
  /**
   * Which reasoning stretch of this turn the two fields above describe,
   * counting from 1 — or null when the agent is not reasoning.
   *
   * The value carries no meaning of its own; it exists so a client can tell a
   * NEW stretch from more deltas about the current one. Without it, two
   * stretches separated by tool calls are indistinguishable on the wire from
   * one long stretch, and a renderer has nothing to key a fresh row on.
   */
  thinkingStretch: number | null;
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
   * run. Remembered across turns AND across runs on the same model, because it
   * rides the `result` line only and a turn's first request has none of its
   * own. Null until some turn — this run's, or an earlier one on the same
   * model this session — has reported one.
   */
  contextWindowTokens: number | null;
}

/**
 * What a run is parked on, when it is parked on the user at all.
 *
 * Two kinds rather than a boolean because they are different asks and the
 * badge says so: a QUESTION is the agent wanting a decision only the user can
 * make, an APPROVAL is a tool call held at the permission gate. Both stop the
 * turn dead; only one of them means the agent has something to ask.
 *
 * Deliberately NOT a `RunStatus` value. The run genuinely is still running —
 * its process is alive, its turn is open, and every settle path still has to
 * fire — so writing this into the persisted lifecycle column would mean a
 * crash could strand a run in a state no settle path knows how to leave. It is
 * a live fact about an in-memory registry entry, and it is served like one.
 */
export const RunAwaitingSchema = z
  .enum(['question', 'approval'])
  .meta({ id: 'RunAwaiting' });
export type RunAwaiting = z.infer<typeof RunAwaitingSchema>;

/**
 * The hues a sidebar group can wear.
 *
 * NAMES, not colour values, and that is a hard constraint rather than a style
 * preference: the renderer's eslint config makes a literal hex/rgb/hsl an ERROR
 * anywhere under `apps/ui/src/renderer/**`, so a colour sent over the wire
 * would arrive at a call site that is forbidden to use it. Each name resolves
 * to a design token in `styles/global.css`, which is the one place colour
 * values are allowed to exist.
 *
 * The eight are the palette the app already ships (`--avatar-1..8`, mirrored
 * from geniro web) rather than a second set invented here, so a group and an
 * agent avatar can never drift into two different blues.
 */
export const RUN_GROUP_COLORS = [
  'blue',
  'purple',
  'green',
  'orange',
  'pink',
  'indigo',
  'teal',
  'red',
] as const;
export const RunGroupColorSchema = z
  .enum(RUN_GROUP_COLORS)
  .meta({ id: 'RunGroupColor' });
export type RunGroupColor = z.infer<typeof RunGroupColorSchema>;

/** How long a group's name may be — a sidebar label, not a description. */
export const RUN_GROUP_NAME_MAX = 60;

/**
 * One sidebar group on the wire.
 *
 * No `.meta({ id })` on this ROOT: it backs an array response DTO, and an id
 * here would register the component under that name while the array response
 * still points at the DTO class — the dangling `$ref` `setupSwagger` fails the
 * boot on.
 */
export const RunGroupWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: RunGroupColorSchema,
  position: z
    .number()
    .int()
    .describe('Sidebar order, ascending and contiguous from 0'),
  collapsed: z.boolean(),
  autoCwd: z
    .string()
    .nullable()
    .describe(
      'Canonical project folder whose new chats file themselves here — a run started in it, or anywhere inside it, matches; null for a group filled by hand',
    ),
});
export type RunGroupWire = z.infer<typeof RunGroupWireSchema>;

/** A run projected to the wire (chat and workflow runs share the shape). */
export const RunWireSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  /**
   * Parked on the user, and on what — null when it is not.
   *
   * On the SNAPSHOT as well as the `run_status` broadcast, because the two
   * cover different moments: the broadcast carries the transition, and this
   * carries the state a client that reconnected AFTER it has no other way to
   * learn. A run parked on a question emits nothing further by definition, so
   * without it a reloaded window shows a spinner until the user clicks in.
   */
  awaiting: RunAwaitingSchema.nullable().describe(
    'What this run is parked on waiting for the user, or null when it is not parked',
  ),
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
  configDir: z
    .string()
    .nullable()
    .describe(
      "Canonical agent config directory this chat runs under — which account/profile its CLI uses; null = the CLI's default. Fixed at creation, like cwd — the settings PATCH does not carry it",
    ),
  groupId: z
    .string()
    .nullable()
    .describe(
      'Sidebar group this run is filed under; null for one sitting loose. Both run kinds carry it — the sidebar lists chats and workflow runs together',
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

/**
 * One conversation a CLI already holds on this machine, offered so the user can
 * carry it on inside geniro.
 *
 * `cwd` is nullable on the wire and NOT optional in practice: a session whose
 * folder the CLI never recorded cannot be resumed anywhere sensible, so the
 * picker offers it read-only rather than pretending a resume would work. Every
 * other field is a label.
 */
export const AgentSessionWireSchema = z
  .object({
    id: z.string().describe('The id the CLI resumes by'),
    cwd: z
      .string()
      .nullable()
      .describe(
        'Folder the conversation ran in; null when the CLI recorded none',
      ),
    title: z
      .string()
      .nullable()
      .describe("The CLI's own title, or the conversation's opening prompt"),
    updatedAt: z
      .number()
      .nullable()
      .describe('Epoch ms of the last write; null when the CLI records none'),
  })
  // NESTED, never a response root — so an id here names the row type in the
  // generated client instead of leaving it `…DtoSessionsInner`. Compare
  // `AgentMcpServer` above, and the note on the listing below for what the same
  // id on a ROOT would cost.
  .meta({ id: 'AgentSession' });
export type AgentSessionWire = z.infer<typeof AgentSessionWireSchema>;

/**
 * The sessions listing, with the two things an empty list could mean.
 *
 * Both reasons are carried rather than folded into one, because they answer
 * different questions and a picker shows them in different places:
 * `unavailableReason` says the list could not be taken at all,
 * `partialReason` says it was taken and does not cover everything this CLI
 * holds — cursor's interactive chats live in a store its ACP server will not
 * open, and a user with months of terminal history needs to be told that rather
 * than left to conclude the feature is broken.
 */
export const AgentSessionListingWireSchema = z.object({
  sessions: z.array(AgentSessionWireSchema),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why this CLI could not be asked at all; null when it could'),
  partialReason: z
    .string()
    .nullable()
    .describe('What this listing does not reach; null when it reaches all'),
});
// No `.meta({ id })` on this one: it is a RESPONSE DTO ROOT, and nestjs-zod
// would then register the component under the id while the route still points
// at the DTO class name — the dangling `$ref` `setupSwagger` fails the boot on.
// The nested row above carries an id precisely because it is not a root.
export type AgentSessionListingWire = z.infer<
  typeof AgentSessionListingWireSchema
>;
