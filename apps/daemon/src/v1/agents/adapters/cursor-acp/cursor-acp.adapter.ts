import { AgentKind } from '../../../runs/runs.types';
import { resolveAgentBinary } from '../../utils/agent-binary';
import type { AcpToolCall } from '../acp/acp.types';
import { AcpTurnDriver, type AutoDecision } from '../acp/acp-driver';
import type {
  AdapterConfig,
  AgentCommandOptions,
  AgentMcpListingResult,
  AgentMcpServersInput,
  AgentModel,
  AgentTurnInput,
  TurnDriver,
} from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import {
  CURSOR_MCP_EMPTY_MARKER,
  CURSOR_MCP_LIST_ARGS,
  CURSOR_MCP_LIST_FAILED_MESSAGE,
  CURSOR_MCP_LIST_TIMEOUT_MS,
  CURSOR_MCP_LIST_UNREADABLE_MESSAGE,
  CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON,
} from './cursor-acp.const';
import { parseCursorMcpList } from './utils/cursor-mcp-list.utils';

/** Cursor's read-only planning mode, as `session/new` reports it. */
const CURSOR_PLAN_MODE_ID = 'plan';

/** Cursor-specific constructor options (the bag stays a test seam). */
export interface CursorAcpAdapterOptions extends AgentAdapterOptions {
  /** Advertised to the agent as `clientInfo.version`; the daemon's version. */
  clientVersion?: string;
}

/**
 * Decide a permission request without the user, from the turn's approval mode.
 * Exported so a spec can drive the policy directly, without a live agent.
 *
 * - `auto` (and a legacy chat turn with no mode at all) auto-approves
 *   everything, preserving the unattended semantics the `-p --force` path had.
 * - `acceptEdits` auto-approves file-edit tool calls and asks for the rest.
 * - `ask` and `plan` ask for everything.
 *
 * Every mode except `auto` is a NEW capability here: `cursor-agent -p` has no
 * permission protocol at all, so the legacy adapter had to run every mode
 * under `--force` and let the caller surface the degrade.
 */
export function cursorAutoDecision(
  approvalMode: AgentTurnInput['approvalMode'],
  toolCall: AcpToolCall,
): AutoDecision {
  if (approvalMode === undefined || approvalMode === 'auto') {
    return 'allow';
  }
  if (approvalMode === 'acceptEdits') {
    // ACP's ToolKind taxonomy: `edit` is a file modification. `delete`/`move`
    // are destructive and stay behind a user verdict, matching what
    // acceptEdits means for the claude path.
    return toolCall.kind === 'edit' ? 'allow' : null;
  }
  return null;
}

/**
 * Drives `cursor-agent acp` — Cursor's first-party Agent Client Protocol
 * server — over JSON-RPC on stdio, in place of the one-shot
 * `cursor-agent -p --output-format stream-json` stream.
 *
 * What this buys over the legacy adapter:
 * - **Real permission prompts.** ACP's `session/request_permission` is a
 *   baseline agent→client request, so `ask`/`acceptEdits` finally mean what
 *   they say instead of degrading to `--force`.
 * - **Client-supplied MCP servers.** The call-runtime endpoint travels in
 *   `session/new`, so a cursor caller node no longer needs its token planted
 *   in the run cwd's `.cursor/mcp.json` around the turn — and the token now
 *   rides an HTTP header inside a stdin frame rather than a file on disk.
 * - **A typed event stream.** `session/update` replaces the version-volatile
 *   NDJSON the legacy mapper has to guess its way through.
 *
 * One turn is still one process: spawn → handshake → prompt → stop reason →
 * exit. That keeps `ProcessRegistry`, cancel, and the graph executor's fan-out
 * exactly as they are; a long-lived per-session process is a separate change.
 */
export class CursorAcpAdapter extends AgentAdapter {
  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.CursorAgent,
      /**
       * ACP has permission requests but no question channel: there is no
       * agent→client method for asking the USER something open-ended, so a
       * callee driven over ACP can never raise one.
       */
      questionToolName: null,
      approval: {
        /**
         * Real, unlike the `-p` transport this replaces:
         * `session/request_permission` is an ACP baseline, so `ask` parks on a
         * user verdict and `acceptEdits` auto-approves `edit`-kind calls only.
         * `plan` is absent deliberately — it maps to an agent-declared session
         * mode we cannot confirm cursor offers, and a plan turn that quietly
         * ran with write access is the one degrade here that costs something.
         */
        modes: ['auto', 'ask', 'acceptEdits'],
        /** The protocol guarantees them; there is no binary fact to prove. */
        probedModes: [],
        degradeOnProbeFail: {},
        /** Nothing degrades: every mode above is honoured as asked. */
        soleModeDegradeReason: null,
      },
      /** Effort rides the model id for this CLI (`sonnet-4-thinking`). */
      efforts: [],
      /**
       * Empty on purpose: ACP carries no per-session model selection, so a
       * model chosen here would be discarded by the turn and reported as not
       * applied. Offering choices would also auto-assign one to every new node.
       */
      builtinModels: [],
      skillRoots: {
        /** No skills convention — only claude has one. */
        skills: [],
        /** `<root>/.cursor/commands/**.md`. */
        commands: [['.cursor', 'commands']],
      },
      /**
       * ACP streams natively: `session/update` carries `agent_message_chunk`
       * increments, with no flag to probe for.
       */
      liveStream: null,
      /**
       * Nothing to ask up front. Cursor reports its invokable set MID-TURN as
       * an `available_commands_update`, which the driver harvests — a separate
       * probe turn would buy nothing the next real turn does not.
       */
      reportedCommands: null,
      mcp: {
        /**
         * No trust probe: the endpoint travels in `session/new` as a
         * client-supplied server, so there is nothing planted in the user's
         * config for the CLI to have trusted or not.
         */
        callToolsRequireTrustProbe: false,
        /** ACP carries the endpoint in-protocol; no cwd config is written. */
        endpointRequiresCwdConfig: false,
        /**
         * Null: this CLI CAN be asked. `cursor-agent mcp list` exists and
         * works without authentication (verified on 2026.07.23-e383d2b), so
         * {@link CursorAcpAdapter.listMcpServers} below answers for real and
         * there is no reason to state in place of a listing.
         *
         * ACP itself still has no agent-to-client inventory of a session's
         * servers — the listing is a subcommand, not a protocol frame — which
         * is why this is an adapter method rather than anything the shared
         * `adapters/acp/` client could provide.
         */
        listingUnavailableReason: null,
        /**
         * Still non-null, and deliberately so after the same verification —
         * {@link CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON} carries the evidence.
         * Saying it keeps every cursor row read-only instead of offering a
         * dead control.
         *
         * All three fields get the one sentence, unlike claude's three
         * distinct ones: the latter two answer "why is THIS row not
         * toggleable" questions that are never reached while the blanket
         * reason above is set.
         */
        toggleUnavailableReason: CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON,
        notInToggleableScopeReason: CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON,
        userDisabledReason: CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON,
      },
      /** Cursor's subscription TUI stays an explicit M4 scope exclusion. */
      plugin: {
        /**
         * `cursor-agent` DOES accept a `--plugin-dir` flag — an earlier
         * revision of this block claimed it did not, which the binary
         * disproves. What was actually probed (2026.07.23-e383d2b) is
         * narrower: a plugin directory carrying an `.mcp.json`, a
         * `.cursor/mcp.json` and a `.cursor-plugin/plugin.json` contributed no
         * servers to `mcp list`, and a wholly nonexistent path was accepted
         * just as silently. Whether a plugin's commands or skills reach a TURN
         * was NOT probed, and the plugin manifest format is undocumented in the
         * CLI's own `--help`. ACP has no client-supplied plugin channel either,
         * the way it has one for MCP servers.
         *
         * So the claim is only that the field a node would fill has no VERIFIED
         * effect on this CLI — which is what keeps a node's `pluginDir` from
         * being validated, refused, or silently dropped for cursor. Establish
         * the turn side before weakening or removing this.
         */
        unavailableReason:
          'cursor-agent has no verified way to load a plugin directory',
      },
      terminal: null,
    };
  }

  /**
   * ACP cannot select a model per session, so there is no list worth offering:
   * every turn runs on whatever the CLI is configured for. Asking
   * `cursor-agent models` would produce a picker whose value the turn discards.
   */
  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }

  /**
   * `cursor-agent mcp list` exists, so this shells out rather than declaring an
   * absence — the fork milestone 4 opened, resolved against the real binary.
   *
   * `processGroup` for the same reason claude's listing needs it: the command
   * HEALTH-CHECKS, which means it launches the user's own stdio servers as
   * children, and killing only the CLI would leave them behind.
   *
   * The three-way split mirrors claude's, and carries the same weight:
   * - a null stdout is the command having FAILED (missing binary, non-zero
   *   exit, deadline) and is reported as such;
   * - zero rows WITH the CLI's empty-folder sentence is a real empty listing;
   * - zero rows WITHOUT it means the output could not be read. That third case
   *   is load-bearing here in a way it is not for claude: cursor rows have no
   *   structural marker, so a reworded release can leave NOTHING in the output
   *   shaped like a row, and this is what turns that into a visible "format
   *   may have changed" instead of a cached "no servers". A row whose STATUS
   *   alone is unrecognised is kept and badged `unknown` rather than dropped
   *   — milestone 4 reversed the drop rule, because a listed server with its
   *   health unstated beats one the user cannot see at all.
   */
  override async listMcpServers(
    input: AgentMcpServersInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    const stdout = await this.runCommand([...CURSOR_MCP_LIST_ARGS], {
      ...options,
      cwd: input.cwd,
      processGroup: true,
      timeoutMs: options.timeoutMs ?? CURSOR_MCP_LIST_TIMEOUT_MS,
    });
    if (stdout === null) {
      return { ok: false, reason: CURSOR_MCP_LIST_FAILED_MESSAGE };
    }
    const servers = parseCursorMcpList(stdout);
    // Anchored to the START OF A LINE, not searched across the whole buffer:
    // the sentence is ordinary English, so a server whose status wording merely
    // CONTAINS it ("weird-srv: No MCP servers configured are approved yet")
    // would otherwise satisfy the empty check and turn an unreadable listing
    // into a confident "this folder has none".
    const saidEmpty = stdout
      .split('\n')
      .some((line) => line.trim().startsWith(CURSOR_MCP_EMPTY_MARKER));
    if (servers.length === 0 && !saidEmpty) {
      return { ok: false, reason: CURSOR_MCP_LIST_UNREADABLE_MESSAGE };
    }
    return { ok: true, servers };
  }

  constructor(private readonly cursorOptions: CursorAcpAdapterOptions = {}) {
    super(cursorOptions);
  }

  // Resolved per turn so the Settings cliPaths override (GENIRO_CURSOR_BIN on
  // the daemon env) takes effect without reconstructing the adapter.
  protected get command(): string {
    return resolveAgentBinary('cursor-agent');
  }

  protected buildArgs(_input: AgentTurnInput): string[] {
    // Every per-turn parameter that has an ACP home (cwd, MCP servers, the
    // prompt, the resumed session, the mode) travels in the protocol instead
    // of argv — which is also what keeps the call token off `ps`.
    return ['acp'];
  }

  /** ACP is a full-duplex dialogue: stdin stays open for the whole turn. */
  protected override keepStdinOpen(_input: AgentTurnInput): boolean {
    return true;
  }

  /**
   * No one-shot payload — the driver writes the opening `initialize` frame
   * from `onStdinReady`, and everything after it is a reply to the agent.
   */
  protected override buildStdinPayload(
    _input: AgentTurnInput,
  ): string | undefined {
    return undefined;
  }

  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    // The daemon receives the Keychain-sourced Cursor key as
    // GENIRO_CURSOR_API_KEY (a GENIRO_-prefixed var that spawn-cli strips from
    // every child env). Re-inject it as CURSOR_API_KEY for THIS child only, so
    // the key never reaches the claude agent. Honor an explicit per-call
    // override in input.env if one is given.
    const cursorApiKey = process.env.GENIRO_CURSOR_API_KEY;
    return {
      ...(cursorApiKey ? { CURSOR_API_KEY: cursorApiKey } : {}),
      ...input.env,
    };
  }

  /**
   * The legacy adapter's stream-json mapper has no ACP counterpart: the whole
   * protocol is stateful, so it lives in a per-turn {@link AcpTurnDriver}.
   * Reaching this method means the base class's default (stateless) path ran,
   * which `createTurnDriver` below replaces.
   */
  protected mapMessage(): never {
    throw new Error(
      'CursorAcpAdapter drives ACP through its per-turn driver, not mapMessage',
    );
  }

  protected override createTurnDriver(input: AgentTurnInput): TurnDriver {
    return new AcpTurnDriver({
      input,
      composeSystemPrompt: (granted) =>
        this.composeSystemPrompt(input, granted),
      clientName: 'geniro',
      clientVersion: this.cursorOptions.clientVersion ?? '0.0.0',
      autoDecide: (toolCall) =>
        cursorAutoDecision(input.approvalMode, toolCall),
      preferredModeId:
        input.approvalMode === 'plan' ? CURSOR_PLAN_MODE_ID : null,
      startupNotices: this.startupNotices(input),
      logger: this.cursorOptions.logger,
    });
  }

  /**
   * Turn parameters ACP cannot carry — reported rather than dropped, because a
   * node that silently ran on the wrong model is exactly the kind of degrade
   * this codebase makes visible.
   */
  private startupNotices(input: AgentTurnInput): string[] {
    const notices: string[] = [];
    if (input.model) {
      notices.push(
        `model '${input.model}' was not applied: ACP carries no per-session model selection, so this turn runs on the agent's configured default`,
      );
    }
    return notices;
  }
}
