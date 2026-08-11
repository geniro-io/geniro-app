/**
 * The slice of the Agent Client Protocol (ACP) wire contract this client
 * sends and reads. Field names and enum members mirror the published schema
 * (`@agentclientprotocol/sdk` v1, PROTOCOL_VERSION 1) exactly.
 *
 * These are declared here rather than taken from the SDK package on purpose:
 * the SDK is ESM-only (`"type": "module"`) while the daemon compiles to
 * CommonJS via swc, and its `Connection` wants to own the subprocess and both
 * streams — which is precisely what `runHeadlessCli` already owns (env
 * stripping, process-group kill, stderr tail, one-terminal-event
 * normalization). We need the CLIENT half over stdio only, which is the small
 * surface below. Everything inbound is parsed defensively through `json-util`,
 * as with every other version-volatile CLI payload in this module: these types
 * describe what we SEND and what we HOPE to read, never a parse guarantee.
 */

/** The protocol version this client implements. */
export const ACP_PROTOCOL_VERSION = 1;

/** Agent-side methods we call. */
export const ACP_AGENT_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionSetMode: 'session/set_mode',
  sessionSetModel: 'session/set_model',
  sessionPrompt: 'session/prompt',
} as const;

/** Client-side methods the agent calls on US. */
export const ACP_CLIENT_METHODS = {
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
} as const;

/** A client-supplied MCP server, HTTP transport (`mcpCapabilities.http`). */
export interface AcpMcpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}

/** `initialize` params. */
export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    /**
     * Both false: this client does not lend the agent its filesystem — the
     * agent uses its own tools against the turn's cwd, exactly as the headless
     * CLI path does today. An agent that calls `fs/*` anyway gets a JSON-RPC
     * "method not found" rather than a hang.
     */
    fs: { readTextFile: boolean; writeTextFile: boolean };
    /** Likewise for `terminal/*`: the agent runs its own commands. */
    terminal: boolean;
  };
  clientInfo: { name: string; version: string };
}

/** The subset of `InitializeResponse.agentCapabilities` we act on. */
export interface AcpAgentCapabilities {
  loadSession: boolean;
  mcpHttp: boolean;
  /**
   * `promptCapabilities.image` — whether `session/prompt` accepts `image`
   * content blocks. The protocol REQUIRES a client to check this before
   * sending one, and an agent that has not advertised it answers a prompt
   * carrying one with an error reply, which would fail the whole turn over an
   * attachment. Absent means false: attaching capability to silence is how a
   * turn ends up sending content the agent never claimed to read.
   */
  promptImage: boolean;
}

/** A `text` block — every prompt has exactly one, carrying the turn's text. */
export interface AcpTextBlock {
  type: 'text';
  text: string;
}

/** An `image` block: base64 bytes plus their media type, as ACP names them. */
export interface AcpImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * The `ContentBlock` variants this client SENDS. ACP defines more (audio,
 * resource, resource_link); we send what a geniro turn actually carries.
 */
export type AcpContentBlock = AcpTextBlock | AcpImageBlock;

/** `session/new` params. */
export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServerHttp[];
}

/** `session/load` params — same as `session/new` plus the id being resumed. */
export interface AcpLoadSessionParams extends AcpNewSessionParams {
  sessionId: string;
}

/**
 * `session/prompt` params. The block array carries the turn's text and, when
 * the agent advertised `promptCapabilities.image`, the images attached to it.
 */
export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

/** `session/set_mode` params. */
export interface AcpSetModeParams {
  sessionId: string;
  modeId: string;
}

/** `session/set_model` params. */
export interface AcpSetModelParams {
  sessionId: string;
  modelId: string;
}

/**
 * One entry of `session/new`'s `models.availableModels`.
 *
 * The identity key is `modelId`, NOT the `id` that `modes.availableModes` uses
 * for the sibling block — the two are shaped alike and named differently, and
 * reading a model entry's `id` yields undefined for every row rather than
 * failing, which is a picker that silently lists nothing.
 *
 * These ids are the agent's OWN namespace and are not interchangeable with the
 * ones `cursor-agent models` prints. Probed on cursor-agent 2026.08.04-aaa8809:
 * `session/new` offers `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`
 * while the subcommand prints `claude-opus-5-thinking-high` for the same model,
 * and `session/set_model` answers the subcommand form with
 * `-32602 Invalid model value`. So the handshake is the only usable source for
 * a picker whose value the turn can actually apply.
 */
export interface AcpModel {
  modelId: string;
  name: string;
}

/**
 * Why the agent stopped. `cancelled` is the only member that is NOT a normal
 * completion — it maps to `turn_cancelled`, never `turn_complete`.
 */
export const ACP_STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;
export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/**
 * How a permission option resolves. We only ever select a `*_once` option: an
 * `*_always` choice would persist a decision past the turn that the user never
 * made at that scope.
 */
export type AcpPermissionOptionKind =
  'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** One option offered by `session/request_permission`. */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

/**
 * The projection of an ACP `ToolCallUpdate` this client uses — enough to name
 * a tool call in the transcript and to let an approval policy classify it.
 */
export interface AcpToolCall {
  toolCallId: string;
  /** Machine name when the agent reports one, else the human title. */
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
  /** ACP `ToolKind` — `edit` is what `acceptEdits` auto-approves. */
  kind: string | null;
  rawInput: unknown;
  rawOutput: unknown;
}

/** Token/cost accounting as ACP reports it, across both of its carriers. */
export interface AcpUsageSnapshot {
  /** `PromptResponse.usage` — per-turn token counts. */
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * `UsageUpdate.used` — tokens of the context window in use. ACP reports this
   * directly, so unlike the claude adapter we never have to sum cache counters
   * to reconstruct it.
   */
  contextUsed: number | null;
  costAmount: number | null;
  costCurrency: string | null;
}
