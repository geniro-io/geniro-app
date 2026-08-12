import { AgentKind } from '../../../runs/runs.types';
import { resolveAgentBinary } from '../../utils/agent-binary';
import type { AcpToolCall } from '../acp/acp.types';
import { AcpTurnDriver, type AutoDecision } from '../acp/acp-driver';
import {
  acpModelProbeFrames,
  acpModelProbeSettled,
  readAcpModelProbe,
} from '../acp/acp-models';
import type {
  AdapterConfig,
  AdapterQuestion,
  AgentCommandOptions,
  AgentMcpListingResult,
  AgentMcpServersInput,
  AgentModel,
  AgentTurnInput,
  TurnDriver,
} from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import {
  CURSOR_ACP_ARGS,
  CURSOR_ACP_CLIENT_NAME,
  CURSOR_ASK_QUESTION_METHOD,
  CURSOR_MCP_EMPTY_MARKER,
  CURSOR_MCP_LIST_ARGS,
  CURSOR_MCP_LIST_FAILED_MESSAGE,
  CURSOR_MCP_LIST_TIMEOUT_MS,
  CURSOR_MCP_LIST_UNREADABLE_MESSAGE,
  CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON,
  CURSOR_MODEL_PROBE_TIMEOUT_MS,
  CURSOR_SILENTLY_DECLINED_METHODS,
} from './cursor-acp.const';
import { parseCursorMcpList } from './utils/cursor-mcp-list.utils';
import {
  cursorAdapterQuestion,
  encodeCursorQuestionReply,
  readCursorQuestions,
  withCursorAnswer,
} from './utils/cursor-question.utils';

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
       * Baseline ACP has permission requests and no question channel, but
       * cursor added one as a vendor extension — so a callee driven over this
       * transport CAN raise a question, and used to have it declined
       * in-protocol. The method name doubles as the tool name because that is
       * the only identity the request carries; nothing outside this adapter
       * cares which it is.
       *
       * Documented rather than observed — see the block above
       * {@link CURSOR_ASK_QUESTION_METHOD} — which is why the driver gates on
       * a payload it can actually read and otherwise declines as before.
       */
      questionToolName: CURSOR_ASK_QUESTION_METHOD,
      /**
       * False, unlike claude. The question arrives as a JSON-RPC request the
       * agent sends whatever session mode it is in, so an unattended `auto`
       * node keeps `auto` — where claude has to be moved onto its stdio
       * permission dialogue to keep the tool wired at all.
       */
      questionsCostAskPosture: false,
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
      /**
       * Effort rides the model id for this CLI, and the id is an OPAQUE TOKEN —
       * so effort is not independently selectable here, and this empty list is a
       * measurement rather than an omission.
       *
       * `cursor-agent --help` says otherwise, which is the trap: it advertises
       * "Parameterized models accept quoted bracket overrides, e.g.
       * 'claude-opus-4-8[context=1m,effort=high,fast=false]'". Probed on
       * 2026.08.04-aaa8809 over `cursor-agent acp` — a handshake, then
       * `session/set_config_option {configId:'model'}` per candidate, against the
       * account's own current id
       * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`:
       *
       *   effort=high   -> ACCEPTED   (byte-identical to the advertised id)
       *   effort=low    -> -32602 Invalid params
       *   effort=medium -> -32602 Invalid params
       *   effort=xhigh  -> -32602 Invalid params
       *   effort=max    -> -32602 Invalid params
       *   adding effort= to an id that lacked one -> -32602 Invalid params
       *
       * `xhigh` is the decisive one: cursor itself ships
       * `claude-opus-4-7[…,effort=xhigh,…]`, so the value is valid to the vendor
       * and still rejected on another model. Only ids the agent enumerated are
       * accepted, and it enumerates exactly ONE effort per model.
       *
       * So the model picker already offers every effort this CLI permits, and an
       * effort chip could only ever produce a failed turn. RE-CHECK by re-running
       * that probe if a release starts enumerating two ids for one model, or if
       * `configOptions` gains a category other than `mode`/`model` — those are
       * the two shapes that would make a real chip possible.
       */
      efforts: [],
      /**
       * Empty because {@link CursorAcpAdapter.listModels} answers for real —
       * `builtinModels` is the fallback for a CLI that cannot be asked, and
       * this one can. A hardcoded list would also go stale against an account
       * whose available models change without the binary changing.
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
        /**
         * Null: no such split is known for this CLI. `cursor-agent mcp list`
         * reports what the folder configures, and nothing has been observed
         * that its ACP session loads on top of that. A note invented here
         * would be a claim about the CLI nobody verified.
         */
        interactiveOnlyNote: null,
        userDisabledReason: CURSOR_MCP_TOGGLE_UNAVAILABLE_REASON,
        /**
         * `cursor-agent mcp login <identifier>` — "Authenticate with an MCP
         * server configured in .cursor/mcp.json or ~/.cursor/mcp.json", read
         * from the CLI's own `mcp --help`. Inline rather than named, per this
         * adapter's rule: `getConfig()` is its only reader.
         *
         * The row this serves now exists. When this was written no cursor row
         * could carry `needs_auth` — the parser knew `ready` / `Error:` /
         * `not loaded` / `disabled` and nothing naming authentication, and a
         * marker invented for unobserved wording is how a parser silently
         * matches nothing. On 2026-08-11, against 2026.08.04-aaa8809, a real
         * listing printed `requires_authentication` on eight of eleven servers;
         * {@link CURSOR_MCP_NEEDS_AUTH_MARKER} carries that capture and the
         * parser maps it, so this sign-in is reachable rather than latent.
         */
        loginArgs: ['mcp', 'login'],
        loginUnavailableReason: null,
      },
      auth: {
        /**
         * `cursor-agent login` — "Authenticate with Cursor. Set NO_OPEN_BROWSER
         * to disable browser opening", from the CLI's own `--help`
         * (2026.08.04-aaa8809). Inline rather than named, per this adapter's
         * rule: `getConfig()` is its only reader.
         *
         * The ACP server names the same flow from the other side: its
         * `initialize` reply advertises
         * `authMethods: [{ id: 'cursor_login', description: "… Run 'agent
         * login' first if not logged in." }]`, so this is the command the agent
         * itself points at.
         */
        loginArgs: ['login'],
        loginUnavailableReason: null,
        /**
         * Empty, and not a gap: no auth-failure wording has been OBSERVED from
         * this CLI. cursor-agent is not signed in on the machine this was built
         * on, so what a lapsed session prints here is unknown, and a marker
         * guessed from that either matches nothing or matches an unrelated
         * failure and offers a cure for something else.
         *
         * The capability itself is real and declared above, so the agents panel
         * still offers sign-in — that control needs no failure to be pressed.
         * Fill this in from a real failed turn, not from the CLI's `--help`.
         */
        expiredMarkers: [],
      },
      configDir: {
        /**
         * `CURSOR_CONFIG_DIR` IS read by this binary — its own bundled source
         * resolves it first, then `XDG_CONFIG_HOME/cursor`, then the default —
         * and probing it (2026.08.04-aaa8809) with a fresh empty directory
         * wrote `cli-config.json` and `statsig-cache.json` into it. So the
         * mechanism exists.
         *
         * What it does NOT do is the thing this field is offered FOR. The same
         * probe's `mcp list` still reported the DEFAULT profile's servers, so
         * the toolbelt does not travel with the directory; and the account
         * cannot either, because geniro hands this CLI its identity as
         * `CURSOR_API_KEY` from the Keychain (`buildEnv`), not as a file in
         * that directory. Offering the control here would promise a different
         * subscription and deliver the same one.
         *
         * Re-probe those two things — a signed-in session inside the directory,
         * and servers that follow it — before declaring it usable.
         */
        envVar: null,
        unavailableReason:
          'cursor-agent takes its account from the API key geniro injects, not from a config directory — pointing a run at one would not change the subscription',
      },
      followUp: {
        /**
         * ACP's `session/prompt` is ONE request per turn — there is no frame
         * that adds a user message to a prompt already in flight. So the
         * adapter leaves `buildFollowUpPayload` at its default, the turn handle
         * answers false, and the chat route 409s RUN_BUSY.
         *
         * The renderer shows this sentence on the disabled "send now" control:
         * the message still goes out the moment the turn ends, and saying why
         * it waits is the difference between a queue and a dead button.
         */
        unavailableReason:
          'cursor-agent takes one prompt per turn — ACP has no channel for a message mid-turn',
      },
      /**
       * Probe-verified on 2026.07.23-e383d2b, and the reason is worse than a
       * plain no: `cursor-agent --resume <id>` ACCEPTS an ACP session id and
       * then opens an EMPTY chat, silently creating one under that id. ACP
       * sessions are not in the CLI's chat store — asked for a codeword set in
       * the ACP session, the resumed CLI answered NOTHING-HERE. Cursor's own
       * IDE is no route either: staff confirm IDE and CLI chats are separate
       * stores that do not sync, and no open-by-id deeplink exists.
       *
       * So the button must be refused rather than wired: it would look like it
       * worked and drop the user into a blank conversation.
       *
       * RE-VERIFIED 2026-08-11 against 2026.08.04-aaa8809, because a user asked
       * for exactly this button and a sibling claim in this same config (that
       * ACP carries no per-session model) had been refuted by a later probe. It
       * held, and now has a mechanism rather than an observation:
       *
       * - THREE stores, built by two path helpers in the shipped bundle:
       *   `chats/<md5(abs cwd)>/<uuid>/store.db` (what `--resume` reads),
       *   `acp-sessions/<uuid>/store.db` (what ACP writes, referenced only by
       *   the ACP module), and the IDE's own `state.vscdb`.
       * - `md5` of this repo's path resolves to a `chats/` directory that
       *   EXISTS AND IS EMPTY while `~/.cursor/acp-sessions/` holds nine
       *   sessions naming that same cwd. That is precisely why `--resume`
       *   opened a blank chat: it looks somewhere ACP never writes.
       * - Cross-store id joins: 23 ACP ids and 2556 CLI chat ids against the
       *   IDE's 708 `composerHeaders` rows — zero matches either way. Ids are
       *   UUIDs in all three, so the separation is the STORE, never the format.
       * - `Cursor.app` declares one URL scheme (`cursor`) and no route targets a
       *   thread by id; `/prompt?text=` opens a NEW chat. A per-agent web URL
       *   (`cursor.com/agents/bc-…`) is minted only for `kind === "cloud"`, and
       *   a local run has no `bc-…` id to put in it.
       * - Cursor staff, 2026-07-13, naming the paths: "no common stable session
       *   id and no IDE to CLI bridge for `--resume`."
       *
       * Re-check when either of two specific things changes, not on the general
       * "it's on our radar": a `cli`/`acp` member appearing in the IDE's
       * `conversation-search` `source` union, or a `bc-…` id being minted for a
       * local run — which would make the existing `background-agent?bcId=`
       * deeplink template suddenly applicable.
       */
      handoff: {
        kind: 'unavailable',
        reason:
          'cursor-agent cannot reopen this conversation: sessions started over ACP are not in its chat store, and resuming one would silently open an empty chat',
      },
    };
  }

  /**
   * The models this account can run, read from an ACP handshake.
   *
   * An earlier revision returned `[]` and said ACP carries no per-session
   * model. The binary disproves it (2026.08.04-aaa8809): `session/new` replies
   * with a `models` block naming `currentModelId` and `availableModels`, and
   * `session/set_model` answers `{}` — which {@link AcpTurnDriver} now sends
   * before the prompt, so a chosen model is applied rather than discarded.
   *
   * Read from the HANDSHAKE and never from `cursor-agent models`, though the
   * subcommand exists and would be one cheap `execFile`: the two print
   * different id namespaces for the same model — `claude-opus-5-thinking-high`
   * there against
   * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]` here —
   * and `session/set_model` rejects the subcommand form outright with
   * `-32602 Invalid model value`. A picker built from it would refuse every
   * choice the user made.
   *
   * `processGroup` for the reason the MCP listing needs it: this spawns a real
   * CLI that stays alive, so the read owns terminating it. It cannot be an
   * `execFile` either way — the answer requires WRITING two frames first.
   */
  override async listModels(
    options: AgentCommandOptions = {},
  ): Promise<AgentModel[]> {
    // A DISPOSABLE folder, never the daemon's own cwd. A model vocabulary is an
    // ACCOUNT fact — `ModelsService` caches it per CLI version with no cwd in
    // the key — so no caller's folder belongs here; but `session/new` still
    // roots a real agent session at whatever it is given, and `resolve-cwd.ts`
    // records that an agent must never default to the daemon's own directory,
    // which under `pnpm dev` is this repo.
    // Created INSIDE the try for the reason `listReportedCommands` does it:
    // an unusable probe root must degrade to "we could not ask", never throw
    // out of a listing.
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('models');
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        cwd,
        stdinWrites: acpModelProbeFrames({
          cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
        }),
        settleWhen: acpModelProbeSettled,
        timeoutMs: options.timeoutMs ?? CURSOR_MODEL_PROBE_TIMEOUT_MS,
      });
      return this.readModelProbe(stdout);
    } catch {
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  private readModelProbe(stdout: string | null): AgentModel[] {
    if (stdout === null) {
      // A failed probe is an unknown vocabulary, not an empty one. Returning
      // [] is what the picker renders as "default model only", which is the
      // honest reading of "we could not ask".
      return [];
    }
    return readAcpModelProbe(stdout).map((model) => ({
      id: model.modelId,
      label: model.name,
      source: 'cli',
    }));
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

  /**
   * What this client tells the agent it is, in `clientInfo.version`.
   *
   * One accessor because two callers need it — the turn driver and the model
   * probe — and a fallback spelled twice is the drift a name exists to prevent.
   */
  private get clientVersion(): string {
    return this.cursorOptions.clientVersion ?? '0.0.0';
  }

  protected buildArgs(_input: AgentTurnInput): string[] {
    // Every per-turn parameter that has an ACP home (cwd, MCP servers, the
    // prompt, the resumed session, the mode, the model) travels in the protocol
    // instead of argv — which is also what keeps the call token off `ps`.
    return [...CURSOR_ACP_ARGS];
  }

  /** ACP is a full-duplex dialogue: stdin stays open for the whole turn. */
  protected override keepStdinOpen(_input: AgentTurnInput): boolean {
    return true;
  }

  /**
   * One process per turn, stated rather than inherited.
   *
   * The base already answers false, so this override changes no behaviour —
   * it exists because "this CLI cannot keep its process between turns" and
   * "nobody has got round to it" are the same silence otherwise, and only one
   * of them is a fact a reader can act on. Same standard as `loginArgs` above,
   * which is declared with its reason even though no row can use it yet.
   *
   * ACP has the shape for it: `session/prompt` can be sent again on a session
   * that is already loaded, so the protocol does not forbid a kept process.
   * What is missing is EVIDENCE. cursor-agent is not signed in on the machine
   * this was built on, so no multi-turn ACP session has ever been observed
   * here — and the cost of guessing is not a failed turn but a wrong one: a
   * second prompt on a session the agent considers finished is answered with
   * the previous turn's context, which reads as an agent ignoring what it was
   * just asked. Keeping a process is an optimization; keeping a WRONG one is a
   * correctness bug.
   *
   * Flip this to `keepStdinOpen`'s answer once a signed-in cursor-agent has
   * been observed serving two `session/prompt` calls on one process, and the
   * turn driver has been checked for state that assumes it dies with its turn.
   */
  protected override canHostSession(_input: AgentTurnInput): boolean {
    return false;
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
      clientName: CURSOR_ACP_CLIENT_NAME,
      clientVersion: this.clientVersion,
      autoDecide: (toolCall) =>
        cursorAutoDecision(input.approvalMode, toolCall),
      preferredModeId:
        input.approvalMode === 'plan' ? CURSOR_PLAN_MODE_ID : null,
      declinedWithoutNotice: CURSOR_SILENTLY_DECLINED_METHODS,
      question: {
        method: CURSOR_ASK_QUESTION_METHOD,
        toolName: this.getConfig().questionToolName ?? '',
        accepts: (params) => readCursorQuestions(params).length > 0,
        encodeReply: encodeCursorQuestionReply,
      },
      logger: this.cursorOptions.logger,
    });
  }

  /**
   * The card projection for a parked `cursor/ask_question`. Reached only for
   * a payload `accepts()` already read, so the null arm is the base class's
   * contract rather than a case that happens.
   */
  override questionFrom(input: unknown): AdapterQuestion | null {
    return cursorAdapterQuestion(input);
  }

  /**
   * Carry the card's free text to the reply encoder. It cannot be folded into
   * a tool input the way claude's is — the request is a JSON-RPC call, not a
   * tool call — so it rides a key both ends of this adapter own.
   */
  override withAnswer(input: unknown, answer: string): unknown {
    return withCursorAnswer(input, answer);
  }
}
