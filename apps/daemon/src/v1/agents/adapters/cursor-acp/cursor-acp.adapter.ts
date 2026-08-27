import { existsSync } from 'node:fs';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentKind } from '../../../runs/runs.types';
import type { AgentVersionService } from '../../services/agent-version.service';
import { ModelVocabularyStore } from '../../services/model-vocabulary.store';
import { resolveAgentBinary } from '../../utils/agent-binary';
import { spawnAgentVersion } from '../../utils/agent-version';
import { ModelVocabularyCache } from '../../utils/model-vocabulary-cache';
import {
  isPlainSessionId,
  SESSION_ID_INVALID_MESSAGE,
} from '../../utils/session-id';
import type { AcpToolCall } from '../acp/acp.types';
import { AcpTurnDriver, type AutoDecision } from '../acp/acp-driver';
import {
  ACP_MODEL_CONFIG_CATEGORY,
  acpModelProbeFrames,
  acpModelProbeSettled,
  acpProbeEnumeratedConfigOptions,
  readAcpConfigOptionProbe,
  readAcpConfigOptionsProbe,
  readAcpModelProbe,
} from '../acp/acp-models';
import {
  acpSessionListFrames,
  acpSessionListSettled,
  acpSessionLoadFrames,
  acpSessionLoadSettled,
  readAcpSessionList,
  readAcpSessionReplay,
} from '../acp/acp-sessions';
import type {
  AdapterConfig,
  AdapterQuestion,
  AgentCommandOptions,
  AgentContextUsage,
  AgentContextWindowListing,
  AgentEffortListing,
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpServerHealth,
  AgentMcpServerHealthInput,
  AgentMcpServersInput,
  AgentModel,
  AgentModelParameterListing,
  AgentModelsInput,
  AgentSessionHistory,
  AgentSessionImportInput,
  AgentSessionListing,
  AgentSessionReadInput,
  AgentSessionsInput,
  AgentTurnInput,
  TurnDriver,
} from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import { readFileSafe } from '../utils/fs-safe.utils';
import { matchSessions } from '../utils/session-search.utils';
import {
  CURSOR_ACP_ARGS,
  CURSOR_ACP_CLIENT_META,
  CURSOR_ACP_CLIENT_NAME,
  CURSOR_ACP_SESSIONS_DIR_NAME,
  CURSOR_ASK_QUESTION_METHOD,
  CURSOR_CONFIG_DIR_ENV,
  CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
  CURSOR_EFFORT_PARAMETER_IDS,
  CURSOR_HOME_DIR_NAME,
  CURSOR_MAX_MODE,
  CURSOR_MCP_CONFIG_NAME,
  CURSOR_MCP_DISABLE_ARGS,
  CURSOR_MCP_EMPTY_MARKER,
  CURSOR_MCP_ENABLE_ARGS,
  CURSOR_MCP_LIST_ARGS,
  CURSOR_MCP_LIST_FAILED_MESSAGE,
  CURSOR_MCP_LIST_TIMEOUT_MS,
  CURSOR_MCP_LIST_UNREADABLE_MESSAGE,
  CURSOR_MCP_TOGGLE_FAILED_MESSAGE,
  CURSOR_MCP_TOOLS_ARGS,
  CURSOR_MCP_TOOLS_TIMEOUT_MS,
  CURSOR_MCP_USER_DISABLED_REASON,
  CURSOR_MODEL_PROBE_TIMEOUT_MS,
  CURSOR_OWNED_PARAMETER_IDS,
  CURSOR_PLUGIN_MANIFEST_PATHS,
  CURSOR_PLUGIN_SCAN_DEPTH,
  CURSOR_PLUGINS_DIR_NAME,
  CURSOR_PROFILE_DIR_NAME,
  CURSOR_SESSION_LIST_TIMEOUT_MS,
  CURSOR_SESSION_LOAD_TIMEOUT_MS,
  CURSOR_SESSION_META_NAME,
  CURSOR_SESSION_MISSING_MESSAGE,
  CURSOR_SESSION_STORE_DB_NAME,
  CURSOR_SESSION_STORE_DIR_NAME,
  CURSOR_SILENTLY_DECLINED_METHODS,
  CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON,
  CURSOR_TASK_LAUNCH_MARKER,
  CURSOR_TASK_METHOD,
  CURSOR_TODOS_METHOD,
} from './cursor-acp.const';
import { readCursorAgentFailure } from './utils/cursor-agent-failure.utils';
import { readCursorContextUsage } from './utils/cursor-context-store.utils';
import { parseCursorMcpList } from './utils/cursor-mcp-list.utils';
import {
  cursorProjectRoot,
  descendants,
  mcpOrigins,
  parseMcpServerNames,
  parsePluginMcpPath,
  pluginOnlyNote,
} from './utils/cursor-mcp-scope.utils';
import { parseCursorToolsProbe } from './utils/cursor-mcp-tools.utils';
import {
  cursorModelSelection,
  splitCursorModelId,
} from './utils/cursor-model.utils';
import {
  removeCursorProfile,
  seedCursorProfile,
  sweepStaleCursorProfiles,
} from './utils/cursor-profile.utils';
import {
  cursorAdapterQuestion,
  encodeCursorQuestionReply,
  readCursorQuestions,
  withCursorAnswer,
} from './utils/cursor-question.utils';
import { readCursorSessionTitle } from './utils/cursor-session-meta.utils';
import { readCursorTask } from './utils/cursor-task.utils';
import { parseCursorTodos } from './utils/cursor-todos.utils';

/** Cursor's read-only planning mode, as `session/new` reports it. */
const CURSOR_PLAN_MODE_ID = 'plan';

/** Cursor-specific constructor options (the bag stays a test seam). */
export interface CursorAcpAdapterOptions extends AgentAdapterOptions {
  /** Advertised to the agent as `clientInfo.version`; the daemon's version. */
  clientVersion?: string;
  /**
   * Where per-turn config directories are created; defaults to the OS tmpdir,
   * which is only ever used standalone. Provided by the module as
   * `<userData>/cursor-profiles`.
   */
  profileDir?: string;
  /**
   * Where the CLI's ACP conversations really live, linked into every turn
   * profile as `acp-sessions`. Defaults beside {@link profileDir} in the OS
   * tmpdir; provided by the module as `<userData>/cursor-sessions`.
   *
   * Separate from the profile base because that base is swept wholesale at boot
   * — see `CURSOR_SESSION_STORE_DIR_NAME`.
   */
  sessionStoreDir?: string;
  /**
   * The daemon's memoized `--version` reader, when one is provided.
   *
   * Optional so a standalone or test construction still works — it falls back
   * to forking directly — but the module always supplies it, because this
   * version is read BEFORE every vocabulary cache's key can be computed, so a
   * cache HIT still paid for a process fork. See {@link
   * CursorAcpAdapter.resolveBinaryVersion}.
   */
  versions?: AgentVersionService;
  /** The user's home, for reading their `cli-config.json` (test seam). */
  homeDir?: string;
  /**
   * Where handshake replies survive a daemon restart — see
   * {@link ModelVocabularyStore} and {@link probeModelConfigOptionsShared}.
   *
   * REQUIRED, and deliberately so. It began as an optional field defaulting to
   * a store over `<userData>/model-vocabularies.json`, which made every adapter
   * built without one share a single global file — the specs then leaked
   * probes into each other through the developer's own home directory, and two
   * of them failed for it. A dependency that is wrong when it is implicit
   * should not have a default.
   */
  vocabularyStore: ModelVocabularyStore;
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
 * How long a cached handshake reply stays fresh — the same 10-minute window
 * `EffortsService`/`ContextWindowsService` already give the PARSED vocabulary
 * this feeds, so a cold model pays the ~2s handshake once per that window
 * rather than once per render.
 */
const CURSOR_HANDSHAKE_PROBE_TTL_MS = 10 * 60_000;

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
      subagents: {
        /**
         * True — and it read `false` here for two milestones on a measurement
         * that never touched the wire.
         *
         * What the old entry proved was that `acp.types.ts` declared no parent
         * id and `acp-driver.ts` read none: it measured GENIRO, and then stated
         * the conclusion as a fact about cursor. It even named `cursor/task` as
         * "the single most suggestive artifact found" — a method this adapter
         * was declining on every delegating turn, one file away — and left it
         * for a later reader, because the payload had "never been captured on
         * the wire". Capturing it took one throwaway session and a prompt asking
         * the agent to delegate.
         *
         * REFUTED 2026-08-13 on 2026.08.11-e8db854. The delegation IS on the
         * wire: an ordinary `tool_call` marked `rawInput:{_toolName:"task"}`,
         * and then a `cursor/task` request carrying the description, the full
         * brief, the type, the model and the duration. Every frame is
         * transcribed in the `Background sub-agents` block of
         * `cursor-acp.const.ts`, with what to re-check next.
         */
        reports: true,
        unavailableReason: null,
        /**
         * What the same probe found is NOT there: nothing the delegate itself
         * did. So a cursor block opens onto the brief and the duration rather
         * than a conversation, and says why instead of reading as a delegate
         * that sat idle for thirteen seconds.
         */
        stepsUnavailableReason: CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON,
      },
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
       * REAL, and every level here was accepted by the CLI itself.
       *
       * This list was `[]` for months, on the recorded grounds that effort was
       * not independently selectable — cursor composes it into an opaque model id
       * (`claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`) and
       * rejects every recomposed one with `-32602`. All of that was true, and the
       * conclusion drawn from it was still wrong: it is a property of the
       * HANDSHAKE, not of the CLI. `clientCapabilities._meta.parameterizedModelPicker`
       * — which geniro never sent — switches the agent to a bare model name plus
       * one config option per parameter, and `effort` is one of them. See
       * {@link CURSOR_ACP_CLIENT_META} for the source it was read out of and the
       * probe transcript.
       *
       * The five values below are the ones the agent ENUMERATED for that option
       * on 2026.08.11-e8db854, and applying them was measured, not assumed:
       * `effort=xhigh` and `effort=max` on `claude-opus-5` are both ACCEPTED
       * (the same values the old note recorded as rejected), and `effort=bogus`
       * is `-32602` — so the vocabulary is closed and this is all of it.
       *
       * Weakest first, per the field's contract.
       *
       * RE-CHECK by re-running that probe when the CLI series moves. Two shapes
       * would matter: a value added or removed here, and the vocabulary becoming
       * genuinely per-MODEL in a way that bites — `buildModelParameterConfigOptions`
       * derives the option from the CURRENT model, and a model with no effort
       * axis (`auto-smart`, `gemini-3.1-pro[]`) offers none at all. A run that
       * names an effort such a model does not take is declined in-protocol and
       * surfaces as a `notice` on that turn, which is the honest outcome: the
       * turn runs, and the user is told the setting did not apply.
       */
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'xhigh' },
        { id: 'max', label: 'max' },
      ],
      /** Null: the list above is non-empty, so there is nothing to explain. */
      effortsUnavailableReason: null,
      /**
       * FALSE: the list above is a union of what SOME models offer, and it
       * cannot be complete — `gpt-5.2` enumerates `extra-high` on its own
       * `reasoning` axis (probed 2026-08-19 on 2026.08.11-e8db854), a value no
       * other model has. Checked exhaustively, the daemon refused that level at
       * run creation and the chat could not be started at all, on a level the
       * picker had just offered because the CLI itself listed it.
       *
       * Nothing goes unchecked as a result: `listModelEfforts` asks the CLI per
       * model, and the turn driver refuses a value the model does not offer with
       * a row naming what it does — per turn, against the live agent, rather
       * than against a constant that goes stale with the next model.
       */
      effortsAreExhaustive: false,
      /**
       * Null: this CLI DOES offer the axis, and
       * {@link CursorAcpAdapter.listModelContextWindows} answers per model.
       *
       * Probed 2026-08-21 on 2026.08.11-e8db854 by sweeping all 34 models the
       * account offers: twelve carry a `context` option under the category
       * `model_config`, and the vocabularies differ per model —
       * `claude-opus-5` and `claude-sonnet-5` are `300k|1m`, the `gpt-5.x`
       * family `272k|1m`, `claude-sonnet-4-6` and `claude-opus-4-6` `200k|1m`
       * — while the other twenty-two (including `auto-smart`, `composer-2.5`
       * and every gemini) have no such option at all. The setting has a
       * measured EFFECT rather than merely existing: with the same model and
       * the same prompt, `context=1m` makes this CLI's own accounting report a
       * 1,000,000-token window and `context=300k` a 300,000-token one, which
       * is what the meter's ring then draws.
       */
      contextWindowsUnavailableReason: null,
      /**
       * Empty because {@link CursorAcpAdapter.listModels} answers for real —
       * `builtinModels` is the fallback for a CLI that cannot be asked, and
       * this one can. A hardcoded list would also go stale against an account
       * whose available models change without the binary changing.
       */
      builtinModels: [],
      /**
       * Transcribed from the CLI's own slash-command loader
       * (`src/commands/custom-commands.ts` → `loadCommands` / `loadSkillRoots`
       * in 2026.08.11-e8db854), which is the function that decides what a
       * session can be invoked with. This field read `skills: []` with the
       * note "No skills convention — only claude has one" for two milestones,
       * and that was already false when it was written: cursor reads FIVE
       * skill roots under each of the project and the user's home, and it
       * reads claude's and codex's among them.
       *
       * `.cursor/skills-cursor` is the built-in set the CLI syncs into
       * `~/.cursor` itself, so it is by far the biggest source of rows here —
       * and it is the only one the loader takes at home scope alone. Scanning
       * it under the project root too costs a missing directory's `readdir`
       * and keeps this a flat list; the CLI's own rule discovery does walk it
       * in the workspace, so a project that had one would not be wrong either.
       */
      skillRoots: {
        // None: this CLI's ACCOUNT is not a config directory (see
        // `configDir.unavailableReason`), so a run naming one changes nothing
        // about which skills it can be invoked with, and the home roots below
        // stand whatever a run asks for.
        profileAnchor: null,
        skills: [
          ['.cursor', 'skills'],
          ['.cursor', 'skills-cursor'],
          ['.agents', 'skills'],
          // Third-party extensibility, which the loader defaults to ON.
          ['.claude', 'skills'],
          ['.codex', 'skills'],
        ],
        /** `<root>/.cursor/commands/**.md`, and claude's, which it also loads. */
        commands: [
          ['.cursor', 'commands'],
          ['.claude', 'commands'],
        ],
        /**
         * This CLI has a full plugin system, and it reads BOTH hosts' caches —
         * which is why the composer listed none of them. It reports no command
         * list of its own (its ACP `session/new` reply carries an empty
         * `availableCommands`, measured), so unlike claude the disk scan is the
         * only way a plugin's skills can reach the `/` autocomplete: without
         * this, a skill the agent would happily run could not be offered, and
         * the send was refused as a command this agent does not have.
         *
         * The manifest list and its order are the CLI's own
         * (`[".cursor-plugin/plugin.json", ".claude-plugin/plugin.json",
         * "plugin.json"]`, read out of the shipped 2026.08.11-e8db854 bundle) —
         * which is also what makes reading claude's cache correct rather than
         * opportunistic: this CLI accepts a Claude plugin manifest by design.
         */
        plugins: [
          ['.cursor', 'plugins', 'cache'],
          ['.claude', 'plugins', 'cache'],
        ].map((cacheDir) => ({
          cacheDir,
          manifests: CURSOR_PLUGIN_MANIFEST_PATHS,
          /**
           * A plugin's cursor-specific build first. Verified on the geniro
           * plugin, which ships both: `cursor/skills/` names its skills
           * `geniro-implement` (what this CLI resolves and runs) while
           * `skills/` names the same skill `implement`, so taking both would
           * offer one skill twice under two names.
           */
          skillDirs: [['cursor', 'skills'], ['skills']],
        })),
      },
      /**
       * ACP streams natively: `session/update` carries `agent_message_chunk`
       * increments, with no flag to probe for.
       */
      liveStream: null,
      /**
       * Asked up front, and the reason the earlier `null` was wrong is the
       * whole point of this probe: the harvest it deferred to only exists AFTER
       * a turn has run in that folder, so a chat opened in a folder cursor has
       * never worked in listed the disk scan alone and nothing the CLI reports
       * about itself. Measured 2026-08-19 on 2026.08.11-e8db854 against this
       * repo: the CLI offered 27 commands and the composer showed 21, missing
       * `apply-worktree`, `best-of-n`, `copy-request-id`, `delete-worktree`,
       * `multi-model-review`, `review-agent`, `simplify` and `worktree`.
       *
       * Two facts make the probe cheap, both measured the same day. The
       * `available_commands_update` rides the HANDSHAKE, not the answer: a
       * probe that sent `session/new` and no prompt at all still received it,
       * so the turn is cancelled the moment it lands and the model's reply is
       * never waited on. And an empty probe cwd still gets the
       * home-scope set (22 of the 27; the four worktree entries are project
       * scoped and reach the list through the harvest once a real turn runs
       * there), INCLUDING under a throwaway `CURSOR_CONFIG_DIR` holding only
       * `cli-config.json` — this CLI resolves its skills from the user's home
       * either way, exactly as it does `mcp.json`.
       */
      reportedCommands: {
        /** Never reached by the model: the turn is cancelled on the update. */
        probePrompt: 'Reply with exactly: ok',
        /** A hung handshake must not wedge the caller forever. */
        probeTimeoutMs: 30_000,
        /** Defensive bound — the CLI reports ~27 entries today. */
        maxCommands: 500,
        /**
         * Null: this CLI reports no internal names to strip. Every entry across
         * both readings (27 in a git repo, 22 in an empty directory) was a
         * user-invokable command, so a prefix filter here would be a rule with
         * nothing to match — unlike claude, whose `__remote-workflow` is real.
         */
        internalPrefix: null,
      },
      geniroCommands: [
        {
          name: 'compact',
          description:
            'Summarise the conversation so far and continue from the summary',
          /**
           * geniro's OWN instruction, because this CLI exposes no compaction
           * over the transport geniro drives. Read out of the shipped
           * 2026.08.11-e8db854 bundle: `/summarize` is a TUI command
           * (`{id:"summarize", … run: … onSummarize()}` in `6260.index.js`)
           * whose handler sends that vendor's private
           * `ConversationAction{summarizeAction}`, while the ACP server
           * (`2996.index.js`) advertises `copy-request-id` plus the commands on
           * disk and its `handleSlashCommand` runs exactly that one locally —
           * everything else is forwarded to the model as prose, which is what
           * the reported `/summarize` turn shows happening. The protocol has no
           * compaction method to reach for either (agentclientprotocol
           * discussion #871 is open on precisely this).
           *
           * `-p --output-format stream-json` was checked as the alternative and
           * is not one: a resumed print-mode turn answers `/summarize` with
           * prose exactly as ACP does, and that mode has no stream-json INPUT,
           * no per-tool permission channel and no image blocks — so it would
           * trade this app's approval cards and attachments for nothing.
           */
          prompt:
            'Summarise this entire conversation so far. Write the summary as ' +
            'the handover notes a fresh agent would need to carry the work on ' +
            'with nothing else to go on: what was asked, what was decided and ' +
            'why, what has been done, which files and commands matter, and ' +
            'what is still open. Prefer specifics — names, paths, versions, ' +
            'measurements — over description. Reply with the summary alone.',
          /**
           * True: the summary is only worth writing because the session it
           * summarises is dropped once it lands. This CLI holds no process
           * between turns and resumes each one with `session/load`, so the
           * conversation shrinks exactly when the recorded session id does.
           */
          replacesSession: true,
        },
      ],
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
         * Null: this CLI CAN be told which servers to load, per folder, and
         * {@link CURSOR_MCP_ENABLE_ARGS} carries the bundle source and the
         * measurements. It read non-null for two milestones on the recorded
         * grounds that `mcp enable|disable` were global and wrote
         * `cli-config.json`; both were refuted against 2026.08.11-e8db854,
         * which is why every row in the panel used to render a padlock while
         * the user's own Cursor UI offered live switches for the same servers.
         */
        toggleUnavailableReason: null,
        /**
         * Null: no such split is known for this CLI. `cursor-agent mcp list`
         * reports what the folder configures, and nothing has been observed
         * that its ACP session loads on top of that. A note invented here
         * would be a claim about the CLI nobody verified.
         */
        interactiveOnlyNote: null,
        userDisabledReason: CURSOR_MCP_USER_DISABLED_REASON,
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
        /**
         * EMPTY, and that is a measurement gap rather than a claim: this CLI's
         * server sign-in has never been observed failing, so there is no
         * wording to match. Inventing one would be a marker that silently never
         * fires — the failure this adapter's own `needs_auth` note records
         * having already made once. The consequence is bounded and stated at
         * the field: with no marker, an attempt that failed is reported as
         * having completed, and the LISTING — which is the authority either way
         * — still shows the server unauthenticated on the re-read that follows.
         */
        loginFailureMarkers: [],
        /**
         * Null: `cursor-agent mcp enable <name>` IS the approval, and the CLI
         * says so in both its help ("Add an MCP server to the local approved
         * list") and its own answer. Measured end to end on 2026.08.11-e8db854
         * against a git project whose `.cursor/mcp.json` defined one server:
         *
         * ```
         * $ cursor-agent mcp list
         * probe-echo: not loaded (needs approval)
         * $ cursor-agent mcp enable probe-echo
         * ✓ Enabled and approved MCP server: probe-echo
         * $ cursor-agent mcp list
         * probe-echo: ready
         * ```
         *
         * Its bundle agrees: `mcp list` reports `unapproved` for a server the
         * PROJECT file defines whose key is missing from that project's
         * `mcp-approvals.json`, and the `enable` path calls `addApproval` for
         * exactly that key. So the approval is per project and the cwd is the
         * whole of the scoping, as it is for the toggle beside it.
         */
        approveUnavailableReason: null,
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
         * `cursor-agent logout` — "Sign out and clear stored authentication",
         * read from `cursor-agent logout --help` on 2026.08.04-aaa8809. Inline
         * for the reason `loginArgs` above is: `getConfig()` is its only reader.
         */
        logoutArgs: ['logout'],
        logoutUnavailableReason: null,
        /**
         * EMPTY, and measured rather than assumed. Probed 2026-08-12 on
         * 2026.08.11-e8db854, `NO_OPEN_BROWSER=1 cursor-agent login` with stdin
         * CLOSED:
         *
         * ```
         * Starting login process...
         * Authenticating with Cursor...
         * Waiting for browser authentication...
         * Open a browser and navigate to this link: https://cursor.com/login…
         * ```
         *
         * It then waits on the browser and completes by itself — no code is ever
         * asked for, which is why a daemon-run sign-in needs no input field for
         * this CLI. A marker invented here would fire on nothing and put a dead
         * field in front of the user.
         */
        loginCodePromptMarkers: [],
        /*
         * There is an ELECTRON-SIDE twin of these facts: `LOGIN_PROBES` in
         * `apps/ui/src/main/cli-detect.ts`, which asks this CLI whether it is
         * signed in for the readiness chip. It cannot read this block — it runs
         * before any daemon handle exists — so a CLI gaining an entry here needs
         * one there too, or its chip reads ready while signed out.
         */
        /**
         * OBSERVED, on 2026-08-12 against 2026.08.04-aaa8809, by driving a real
         * ACP handshake with the account logged out (`cursor-agent logout`):
         *
         * ```
         * initialize   -> SUCCEEDS, advertises authMethods: [cursor_login]
         * session/new  -> error { code: -32000,
         *                         message: 'Authentication required',
         *                         data: { message: "Authentication required.
         *                           Please run 'agent login' first, then call
         *                           authenticate() with methodId
         *                           'cursor_login'." } }
         * ```
         *
         * Two details a guess would have got wrong. The failure lands on
         * `session/new`, NOT on the prompt — `initialize` completes cleanly — so
         * a signed-out turn dies before a session exists. And the marker is
         * matched against the driver's rendering of that reply,
         * `acp session failed: Authentication required` (see
         * {@link AcpTurnDriver.onErrorReply}), which is why the short `message`
         * field and not the longer `data.message` is the string to carry.
         *
         * This became reachable only when geniro stopped injecting an API key:
         * while it did, the CLI was always authenticated and no lapsed-session
         * wording could occur. That is why the field sat empty for so long.
         *
         * RE-CHECK when a release changes the `session/new` refusal wording, or
         * moves the auth failure onto `session/prompt` (which would make a turn
         * fail after a session exists, a different shape than this).
         */
        expiredMarkers: ['acp session failed: authentication required'],
        /**
         * A key the USER exported in their own shell — geniro has none of its
         * own to inject, since the Keychain entry and its `GENIRO_` hop went
         * when `cursor-agent` was confirmed to authenticate from `~/.cursor`
         * (probed 2026-08-12: `status` reports the account with no such variable
         * in the environment).
         *
         * It is declared rather than simply left un-stripped because
         * `buildChildEnv` strips it from EVERY child: un-stripping would hand
         * the user's Cursor credential to the claude agent.
         */
        inheritedEnvKeys: ['CURSOR_API_KEY'],
      },
      sessions: {
        /**
         * ACP has a first-class answer for this: `session/list`, which this
         * agent advertises (`sessionCapabilities.list`) and answers with
         * `{sessionId, cwd, title, updatedAt}` — including a GENERATED title,
         * which no disk scan could produce. Probed 2026-08-16 on
         * 2026.08.11-e8db854, with and without a `cwd` filter.
         */
        listingUnavailableReason: null,
        /**
         * The listing is complete for one store and this CLI keeps TWO. Probed
         * the same day: `session/list` returns only what lives in
         * `<configDir>/acp-sessions` (a fresh empty config dir answers with
         * zero rows, so it is profile-scoped, not a global index), while the
         * chats started by the interactive `cursor-agent` TUI live in
         * `~/.cursor/chats/<project>/<chatId>/` — a separate namespace the same
         * server refuses: `session/load` with one of those ids, under its own
         * recorded cwd, answers `-32602 … Session "…" not found`.
         *
         * Said out loud because the alternative is a user with months of
         * terminal history seeing four rows and concluding the import is
         * broken. Their route to those chats is `cursor-agent --resume`, in a
         * terminal, which is the handoff button and not this picker.
         */
        listingPartialReason:
          'only the conversations started in geniro are listed — cursor-agent keeps the ones you started in your terminal separately, and cannot reopen those from here',
        // `session/load` streams the whole prior conversation back before the
        // turn's prompt can be sent, so the history arrives on the first turn
        // via `AgentTurnInput.importSessionHistory` rather than off disk.
        historyUnavailableReason: null,
        /**
         * `session/list` answers with labels — id, cwd, title, timestamp — and
         * takes no search parameter, so the only text this CLI offers about a
         * conversation is the one line the row already shows. The transcript
         * itself is inside the agent's own per-session store, reachable only by
         * `session/load`, which REPLAYS a whole conversation over a spawned
         * process: searching a hundred of them means a hundred spawns.
         */
        contentSearchUnavailableReason:
          'cursor-agent searches conversation titles and folders only — it does not offer what was said inside them.',
      },
      configDir: {
        /**
         * `CURSOR_CONFIG_DIR` IS read by this binary — its own bundled source
         * resolves it first, then `XDG_CONFIG_HOME/cursor`, then the default —
         * and probing it (2026.08.04-aaa8809) with a fresh empty directory
         * wrote `cli-config.json` and `statsig-cache.json` into it. So the
         * mechanism exists. That much is unchanged.
         *
         * What it does NOT do is the thing this field is offered FOR: neither
         * the toolbelt nor the ACCOUNT travels with the directory.
         *
         * - Toolbelt: the original probe's `mcp list` still reported the DEFAULT
         *   profile's servers.
         * - Account: re-measured 2026-08-12, because the reason this field used
         *   to give ("geniro hands this CLI its identity as `CURSOR_API_KEY`")
         *   stopped being true when that injection was removed. Pointed at a
         *   fresh empty `CURSOR_CONFIG_DIR`, the CLI wrote a `cli-config.json`
         *   carrying NO `authInfo` key — the real `~/.cursor/cli-config.json`
         *   has one — and `cursor-agent status` run under that same directory
         *   still reported the DEFAULT account. So the CLI writes its config
         *   there while resolving the account from outside it.
         *
         * The verdict therefore stands on its own footing now: offering the
         * control would promise a different subscription and deliver the same
         * one. Re-probe both halves — an `authInfo` that lands inside the
         * directory, and servers that follow it — before declaring it usable.
         */
        envVar: null,
        unavailableReason:
          'cursor-agent reads a config directory but keeps the account outside it — a fresh one still resolves the same login, so pointing a run at one would not change the subscription',
        /**
         * Moot while the field above refuses the switch outright — there is no
         * profile to move a conversation TO — but stated rather than left to a
         * default, because the two questions are genuinely separate and the
         * next reader should not have to infer this one from the other.
         */
        sessionCarryUnavailableReason:
          'cursor-agent cannot be pointed at another profile at all, so there is nowhere to move a conversation to',
      },
      followUp: {
        /**
         * This said "ACP has no channel for a message mid-turn" for two
         * milestones, on the strength of the SPEC — `session/prompt` is one
         * request per turn — and it was wrong about the BINARY, which is the
         * distinction `.claude/rules/agent-adapters.md` exists to force.
         * Reported as "instant sending of a queued message doesn't work",
         * and probed on 2026.08.11-e8db854: a second `session/prompt` sent
         * against a live session is ACCEPTED. What it does is interrupt — the
         * first prompt answers `{"stopReason":"cancelled"}`, the second runs to
         * `end_turn`, and the agent plainly still holds the conversation (told
         * "STOP counting, reply BANANA" mid-count, it replied `BANANA`).
         *
         * So the channel exists and the driver owns it (`AcpTurnDriver.
         * sendFollowUp`, since the frame needs the session id and has to be
         * recorded to be understood), and what differs from claude is stated
         * below rather than hidden behind a working button.
         */
        unavailableReason: null,
        /**
         * True, and the field exists for this: a press drops whatever
         * cursor-agent is doing — a tool call in flight included — and answers
         * the new message instead. Claude's channel adds to the turn.
         */
        interrupts: true,
      },
      usage: {
        /**
         * It reports NONE. Measured 2026-08-12 on 2026.08.11-e8db854, from a
         * full raw frame capture of two real turns (a read/edit turn and a
         * command turn) rather than from an empty field in the database:
         *
         * - The `session/update` variants sent across both turns were
         *   `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
         *   `tool_call_update`, `available_commands_update` and
         *   `session_info_update`. There was NO `usage_update` — the ACP
         *   notification this client reads (`AcpTurnDriver`'s `usage_update`
         *   arm, which takes `used` and `cost`).
         * - `session/prompt`'s reply was `{"stopReason":"end_turn"}` and nothing
         *   else — no `usage` object, the other channel the driver reads.
         * - `session_info_update`, the one variant the driver drops unread,
         *   carries a `title` and nothing more.
         * - Zero occurrences of any token/cost-shaped key anywhere in the
         *   captured frames.
         *
         * So the reader is correct and there is nothing to read ON THE WIRE: no
         * context used, no window, no spend. RE-CHECK by capturing a turn's
         * frames again — a `usage_update` appearing is all it would take, since
         * the driver already handles it and the meter would light up with no
         * further change here.
         *
         * The CONTEXT half of that is now answered off-protocol regardless, out
         * of this CLI's own session store (`readContext` in `createTurnDriver`),
         * so the sentence below names only what is still genuinely missing.
         * Saying more than that is what the reported defect was made of: the
         * reason claimed there was "no context figure to show" while the panel
         * three pixels away was showing one.
         */
        unavailableReason:
          'cursor-agent does not report what a conversation costs, so no cost can be shown for this chat',
        /**
         * No breakdown either — RE-MEASURED 2026-08-15 on 2026.08.11-e8db854,
         * because "the CLI shows a percentage, so it must send one" is a
         * reasonable thing to expect and the old note rested on an older
         * capture.
         *
         * What was actually checked this time:
         *
         * - A full raw frame capture of a real TOOL-USING turn (read a file,
         *   answer, end) through the daemon's own `agent-stdio` channel. The
         *   `sessionUpdate` variants sent were `user_message_chunk`,
         *   `agent_message_chunk`, `available_commands_update`, `tool_call`
         *   and `tool_call_update`. `session/prompt` answered
         *   `{"stopReason":"end_turn"}` and nothing else. Grepping the whole
         *   capture for any key matching token/usage/cost/context found
         *   exactly three, all of them the word "context" inside
         *   `promptCapabilities.embeddedContext`. There is no usage on this
         *   wire, at all.
         * - The shipped bundle: `usage_update` appears ONLY in the ACP schema
         *   module (`8096.index.js`, the protocol's own type definitions) and
         *   in no module that sends anything — the schema knows the shape, the
         *   agent never emits it.
         * - The CLI DOES count tokens, which is why its TUI can show a
         *   percentage: `tokenDelta` carries a running `tokens`, and
         *   `GetEffectiveTokenLimitResponse{token_limit}` is a server call it
         *   makes. Both live on its own internal interaction stream — the one
         *   the TUI renders — and neither is forwarded to an ACP client.
         * - Cursor's CLI docs list no `/context`, `/usage` or `/tokens`
         *   command and no output-format field carrying any of it. The one
         *   related command, `/summarize`, FREES context rather than reporting
         *   it.
         *
         * So the gap is real and structural, not a field this adapter is
         * failing to read. RE-CHECK by re-running that capture — a single
         * `usage_update` frame appearing is all it would take, since
         * `AcpTurnDriver` already reads one; and `readContextUsage` below is
         * where a breakdown would be assembled if the picture changes.
         */
        /**
         * It DOES report a breakdown — just not over ACP. It writes a full
         * per-category accounting into its own session store for every turn,
         * and `readContextUsage` below reads it from there. See that method
         * and `utils/cursor-context-store.utils.ts`.
         */
        breakdown: { kind: 'reads', channel: 'session-store' },
        /**
         * Nothing on this transport says anything about the ACCOUNT. ACP has
         * no such method, cursor advertises no vendor extension for one, and
         * the session store this adapter already reads for the window holds a
         * per-conversation token accounting — not a subscription's remaining
         * allowance. There is no `cursor-agent` subcommand for it either
         * (`status --format json` answers `isAuthenticated` and the account,
         * and nothing about limits), so the honest answer is a sentence rather
         * than an empty section a user would read as "no limits".
         */
        planLimits: {
          kind: 'unavailable',
          reason:
            'cursor-agent does not report your plan limits, so there is no remaining allowance to show here',
        },
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
       * RE-VERIFIED AGAIN 2026-08-12, against the newer 2026.08.11-e8db854 and
       * Cursor 3.15.6, because a user asked a second time — for "open this
       * session in Cursor web or the Cursor app, the way we do with claude in a
       * terminal". Still no. What is new is that the separation is now read off
       * the SHIPPED SOURCE rather than inferred from directory contents, which
       * is the strongest form this can take short of the vendor changing it:
       *
       * - Both store paths are HARDCODED, with no flag, env var or config key
       *   between them. `join(cursorHome, "acp-sessions")` appears in exactly
       *   one chunk (`2996.index.js`, the ACP module) and
       *   `join(cursorHome, "chats") / md5(resolve(cwd))` in four others. So
       *   there is no setting that would make an ACP session land where
       *   `--resume` looks; it is not a default to override.
       * - `2996.index.js` is the only chunk naming both `acp-sessions` and
       *   `resume`, and its single `resume` mention is not a read of that store.
       * - An ACP session's `meta.json` carries `{schemaVersion, cwd, title}` —
       *   no chat id, and no `bc-…`, so neither re-check trigger below has
       *   fired. Nor is any `bc-…` id present anywhere in a local session's
       *   `store.db-wal`.
       * - The ONLY `cursor://` route in the whole bundle is
       *   `cursor://internal/local-pr-creation-forge`. Cursor.app still
       *   declares the one `cursor` scheme.
       * - The `cursor` IDE CLI's only chat affordance is `--chat` ("Open a
       *   standalone chat window"), which opens a NEW one in the IDE's own
       *   third store.
       *
       * Re-check when either of two specific things changes, not on the general
       * "it's on our radar": a `cli`/`acp` member appearing in the IDE's
       * `conversation-search` `source` union, or a `bc-…` id being minted for a
       * local run — which would make the existing `background-agent?bcId=`
       * deeplink template suddenly applicable.
       *
       * The user is no longer left to guess at the absence: this sentence is
       * what `GET /v1/capabilities` now reports (it used to be replaced with a
       * generic one), so the panel renders the control inert and says this on
       * hover instead of hiding it.
       */
      handoff: {
        kind: 'unavailable',
        reason:
          'cursor-agent cannot reopen a geniro conversation in your terminal — it keeps those separately from its own chats, and would open an empty one instead',
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
    _input: AgentModelsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentModel[]> {
    // The profile is ignored, and that is this CLI's own declaration rather
    // than an omission: its ACCOUNT is not a config directory (probed — a
    // fresh `CURSOR_CONFIG_DIR` still reports the default account), which is
    // what `configDir.unavailableReason` says. So every run's model list is the
    // same list, and the caller keys it under a null profile.

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
    let profile = '';
    try {
      cwd = this.makeProbeRoot('models');
      // Its own profile, like a turn's: a parameterized handshake can migrate a
      // persisted variant selection, which WRITES the config directory — and a
      // listing must never change what the user's own CLI opens with.
      //
      // With NO session store, unlike a turn's: this handshake opens a real
      // `session/new`, and a probe's throwaway conversation has no business in
      // the store a chat resumes from. It dies with the profile below.
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        homeDir: this.cursorOptions.homeDir,
      });
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        cwd,
        stdinWrites: acpModelProbeFrames({
          cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          // The SAME handshake a turn sends. Without it the probe would list the
          // bracketed variant ids while turns speak bare names, and every model
          // the picker offered would be refused.
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpModelProbeSettled,
        env: { [CURSOR_CONFIG_DIR_ENV]: profile },
        timeoutMs: options.timeoutMs ?? CURSOR_MODEL_PROBE_TIMEOUT_MS,
      });
      return this.readModelProbe(stdout);
    } catch {
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * The effort levels ONE model of this CLI accepts.
   *
   * Overridden because for this CLI the vocabulary belongs to the MODEL, not
   * to the binary — `AdapterConfig.efforts` can only ever be the UNION, and a
   * union is what offered `max` on a model that refuses it. Measured
   * 2026-08-19 on 2026.08.11-e8db854, one seeded handshake per model:
   *
   * - `claude-opus-5` → `low medium high xhigh max`
   * - `grok-4.6`      → the same MINUS `max`
   * - `auto-smart`, `composer-2.5` → no `effort` option at all
   *
   * ONE `session/new` answers it, because the reply describes the model the
   * session opened ON — so the model is seeded into the probe profile's
   * `cli-config.json` rather than switched afterwards, which would cost a
   * second round trip (2.2–3.0s measured) for the same answer.
   *
   * Every failure degrades to the CLI-wide superset rather than to silence: a
   * level wrongly hidden is a control the user cannot reach, while one wrongly
   * offered is refused with a sentence on the turn. Only a reply that
   * enumerated options AND did not enumerate this one narrows anything.
   */
  override async listModelEfforts(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentEffortListing> {
    const config = this.getConfig();
    const superset: AgentEffortListing = {
      efforts: [...config.efforts],
      unavailableReason: config.effortsUnavailableReason,
      // Every `return superset` below is a stand-in for an answer this CLI
      // could not give — no model named, the handshake failed or timed out, or
      // the reply enumerated nothing. None of them may ground a refusal.
      exact: false,
    };
    // No model chosen yet — the picker still needs rows, and the union is the
    // honest answer to "what does this CLI offer at all".
    const wanted = (model ?? '').trim();
    if (wanted === '') {
      return superset;
    }
    const stdout = await this.probeModelConfigOptionsShared(
      wanted,
      'efforts',
      options,
    );
    return stdout === undefined
      ? superset
      : this.readEffortProbe(stdout, wanted, superset);
  }

  /**
   * The window sizes ONE model offers, from the same handshake reply the effort
   * listing reads.
   *
   * SAME probe, different option, and no superset behind it: a window size only
   * means anything against the model it belongs to (see
   * `AdapterConfig.contextWindowsUnavailableReason`), so a probe that could not
   * be taken answers "nothing to offer, and here is why" rather than standing
   * in with a union of other models' sizes.
   *
   * Shares its handshake with the effort listing through
   * {@link handshakeProbeCache} rather than running its own: the two chips are
   * asked at different moments by different screens (`EffortsService` /
   * `ContextWindowsService`, each behind its own `ModelVocabularyCache`), so a
   * cold model used to spawn the ~2s handshake TWICE for the one reply.
   * Caching the RAW reply rather than the parsed answer PAIR is what makes
   * that safe — this method still reads its own option out of whatever came
   * back, so nothing here has to agree with the effort listing about what the
   * reply means.
   */
  override async listModelContextWindows(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentContextWindowListing> {
    const wanted = (model ?? '').trim();
    // No model chosen yet. Unlike the effort chip there is no union to fall
    // back on, so the picker draws nothing and says what would fill it.
    //
    // TWIN PARSER: `NO_MODEL_REASON` in
    if (wanted === '') {
      return {
        windows: [],
        unavailableReason:
          'pick a model to see the context-window sizes it offers',
        // The one kind the chip renders differently: nothing has been asked
        // yet, so it says "pick a model" rather than claiming a fixed window
        // for a model nobody has chosen. Carried as a KIND rather than left
        // for the renderer to recognise in this sentence, so rewording the
        // prose here cannot silently change what the control says.
        unavailableKind: 'no-model',
        exact: false,
      };
    }
    const stdout = await this.probeModelConfigOptionsShared(
      wanted,
      'windows',
      options,
    );
    return this.readContextWindowProbe(stdout ?? null, wanted);
  }

  /**
   * Every OTHER setting this model enumerates — the same handshake reply again,
   * read as a SUBTRACTION instead of a lookup.
   *
   * The two listings above each ask the reply for one id they were written
   * knowing. This one asks for everything and removes what geniro already
   * drives ({@link CURSOR_OWNED_PARAMETER_IDS}, plus the model option by its
   * protocol category), so a setting nobody here has heard of still reaches the
   * user. Measured 2026-08-26 on 2026.08.11-e8db854, one seeded handshake per
   * model — three axes were invisible before this existed: `optimize_for`
   * (`auto-smart` only: intelligence | balanced | cost), `thinking`
   * (`claude-opus-5`) and `fast` (`claude-opus-5`, `gpt-5.6-sol`).
   *
   * An option the reply named with NO values is dropped rather than offered: a
   * picker with nothing to pick is the dead control this app keeps removing.
   */
  override async listModelParameters(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentModelParameterListing> {
    const wanted = (model ?? '').trim();
    // No model chosen yet. Like the context listing and unlike the effort one
    // there is no union to fall back on — these axes exist per model, and
    // `optimize_for` exists on exactly one of the thirty-four.
    if (wanted === '') {
      return {
        parameters: [],
        unavailableReason: 'pick a model to see the settings it offers',
        exact: false,
      };
    }
    const stdout = await this.probeModelConfigOptionsShared(
      wanted,
      'parameters',
      options,
    );
    return this.readModelParameterProbe(stdout ?? null, wanted);
  }

  /**
   * The subtraction itself.
   *
   * Same three-way split the effort reader documents, with one difference that
   * matters: a probe that could not be taken answers EMPTY rather than standing
   * in with anything, because there is nothing to stand in with. It is marked
   * `exact: false` so a caller can tell "this model has no further settings"
   * from "nobody could ask".
   */
  private readModelParameterProbe(
    stdout: string | null,
    model: string,
  ): AgentModelParameterListing {
    if (stdout === null || !acpProbeEnumeratedConfigOptions(stdout)) {
      return {
        parameters: [],
        unavailableReason: `cursor-agent could not be asked which settings ${model} offers`,
        exact: false,
      };
    }
    const parameters = readAcpConfigOptionsProbe(stdout)
      .filter(
        (option) =>
          option.category !== ACP_MODEL_CONFIG_CATEGORY &&
          !CURSOR_OWNED_PARAMETER_IDS.includes(option.id) &&
          option.options.length > 0,
      )
      .map((option) => ({
        id: option.id,
        // The agent's own word, never a prettified id: `Optimize For` is what
        // cursor calls `optimize_for`, and inventing that string here would be
        // this app naming another product's setting.
        label: option.name ?? option.id,
        values: option.options.map(({ value, name }) => ({
          id: value,
          label: name,
        })),
        current: option.currentValue,
      }));
    return {
      parameters,
      unavailableReason:
        parameters.length === 0
          ? `${model} offers no settings beyond the ones already on screen`
          : null,
      exact: true,
    };
  }

  /**
   * {@link probeModelConfigOptions}, joined through {@link handshakeProbeCache}
   * so `listModelEfforts` and `listModelContextWindows` share ONE handshake
   * for the same (model, binary version) instead of each spawning its own.
   *
   * The RAW reply is what is shared rather than a parsed answer: each listing
   * still reads its own axis out of it, which is what lets the two agree on
   * one probe without agreeing on what the probe means. That is also why this
   * sits BELOW the caches `EffortsService` and `ContextWindowsService` hold —
   * those keep each service's own PARSED vocabulary, so a cold model missed in
   * both and spawned the handshake twice, neither able to see the other's
   * in-flight probe.
   *
   * `label` still reaches the underlying probe on a cache MISS, so the
   * throwaway profile root it names is unaffected; a HIT answers with no
   * spawn at all, so which label the joining caller asked under is moot.
   *
   * {@link ModelProbeStore} sits INSIDE that cache's fetch rather than beside
   * it, which is what makes the two one mechanism: the single-flight, the
   * version check and the TTL still decide, and the disk is consulted only on
   * the path that would otherwise spawn. That ordering is also the reason the
   * read is synchronous — an await here would let a second caller past the
   * check the cache just made.
   */
  private async probeModelConfigOptionsShared(
    model: string,
    label: string,
    options: AgentCommandOptions,
  ): Promise<string | null | undefined> {
    const version = await this.resolveBinaryVersion(options);
    const kind = this.getConfig().kind;
    // A NULL profile, always: this CLI's account is not a config directory
    // (`configDir.unavailableReason`), so one answer serves every run and
    // keying by profile would only split it into copies, each paying this
    // CLI's own cold handshake — measured at 6–7s.
    const stored = this.vocabularyStore.read(
      kind,
      model,
      null,
      version,
      isProbeReply,
    );
    if (stored !== null) {
      if (stored.stale) {
        // BEHIND the answer, never in front of it: the stored reply is still
        // the best anyone has, so making the user wait for a re-ask would spend
        // the six seconds this store exists to remove.
        void this.takeModelConfigOptions(kind, model, version, label, options);
      }
      return stored.value;
    }
    return this.takeModelConfigOptions(kind, model, version, label, options);
  }

  /**
   * The ask itself, joined through {@link handshakeProbeCache} so a cold read
   * and a background refresh cannot spawn two process groups for one answer.
   *
   * Never rejects — every caller is either serving a picker or running behind
   * an answer already given, and neither has anywhere to put a rejection.
   */
  private takeModelConfigOptions(
    kind: AgentKind,
    model: string,
    version: string | null,
    label: string,
    options: AgentCommandOptions,
  ): Promise<string | null | undefined> {
    return this.handshakeProbeCache
      .read(kind, model, null, version, async () => {
        const fresh = await this.probeModelConfigOptions(model, label, options);
        // Only a reply that ENUMERATED options is worth keeping. The two it
        // excludes are the ones that would be served back as a fact: a probe
        // that could not be taken at all is `undefined`, and a reply nothing
        // can read would be re-served as "cursor-agent could not be asked" long
        // after whatever broke it was fixed.
        if (
          typeof fresh === 'string' &&
          acpProbeEnumeratedConfigOptions(fresh)
        ) {
          this.vocabularyStore.remember(kind, model, null, version, fresh);
        }
        return fresh;
      })
      .catch(() => undefined);
  }

  /**
   * This CLI's own `--version` line — the freshness key
   * {@link handshakeProbeCache} and {@link vocabularyStore} are both checked
   * against.
   *
   * Read through `AgentVersionService`'s 60s memo rather than forked here. The
   * fork is 0.54s and three listings key off this version, so a cache HIT would
   * otherwise pay for a process before it could read a cached byte; the memo's
   * own TTL is short precisely so an upgrade is still noticed while somebody is
   * wondering why. `onSpawn` is not called on a memo hit — no child, nothing to
   * register.
   */
  private resolveBinaryVersion(
    options: AgentCommandOptions,
  ): Promise<string | null> {
    const forkOptions = {
      execFileFn: this.options.execFileFn,
      onSpawn: options.onSpawn,
    };
    return (
      this.cursorOptions.versions?.resolve(
        AgentKind.CursorAgent,
        forkOptions,
      ) ?? spawnAgentVersion(this.command, forkOptions)
    );
  }

  /**
   * One model's `session/new` handshake, as raw stdout — or `undefined` when it
   * could not be taken at all.
   *
   * Extracted because two listings read the same reply for different options,
   * and the SEEDED PROFILE is the mechanism both depend on: the reply
   * enumerates the parameters of whatever model the profile currently holds
   * (measured — a fresh profile opens on `composer-2.5`, which has neither an
   * effort nor a context axis), so the model is chosen by seeding rather than
   * by a `session/set_config_option` round trip.
   *
   * Reached directly only on a {@link handshakeProbeCache} miss — both public
   * listings go through {@link probeModelConfigOptionsShared}.
   */
  private async probeModelConfigOptions(
    model: string,
    label: string,
    options: AgentCommandOptions,
  ): Promise<string | null | undefined> {
    let cwd = '';
    let profile = '';
    try {
      cwd = this.makeProbeRoot(label);
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        homeDir: this.cursorOptions.homeDir,
        // The whole mechanism — see the seed's own doc block.
        model,
      });
      return await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        cwd,
        stdinWrites: acpModelProbeFrames({
          cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpModelProbeSettled,
        env: { [CURSOR_CONFIG_DIR_ENV]: profile },
        timeoutMs: options.timeoutMs ?? CURSOR_MODEL_PROBE_TIMEOUT_MS,
      });
    } catch {
      return undefined;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * What one model's handshake said about its window sizes.
   *
   * Three answers, and every one of them is the CLI's own:
   *
   * - the handshake enumerated a `context` option → its values, in that CLI's
   *   words (`300k`, `1m`), which is the whole picker. Nothing is cached and no
   *   size is stated here — the vocabulary comes from the agent, per model, on
   *   every listing, so it cannot go stale;
   * - it enumerated options and NOT that one → this model has no choice to
   *   offer, and geniro can now say what it DOES run at, because Max Mode is on
   *   for every turn ({@link CURSOR_MAX_MODE}): the model's largest window;
   * - anything else → the probe could not be taken. Unreadable is not the same
   *   as absent, so the sentence says the CLI could not be asked rather than
   *   naming the model.
   *
   * The middle answer briefly became two rows of geniro's own invention
   * (`standard` / `max mode`) whose sizes were LEARNED from turns that had run.
   * That is gone, on the two objections that killed it: Max Mode is a mode
   * rather than a context window, and a learned size is a cache that is wrong
   * from the moment the vendor changes a number until the user next runs a turn.
   */
  private readContextWindowProbe(
    stdout: string | null,
    model: string,
  ): AgentContextWindowListing {
    if (stdout !== null) {
      const option = readAcpConfigOptionProbe(
        stdout,
        CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
      );
      if (option !== null && option.options.length > 0) {
        return {
          windows: option.options.map(({ value, name }) => ({
            id: value,
            label: name,
          })),
          unavailableReason: null,
          unavailableKind: null,
          exact: true,
        };
      }
      if (acpProbeEnumeratedConfigOptions(stdout)) {
        return {
          windows: [],
          unavailableReason: `${model} offers no context setting — it runs at the full window Max Mode gives it.`,
          unavailableKind: 'fixed-window',
          exact: true,
        };
      }
    }
    return {
      windows: [],
      unavailableReason:
        'cursor-agent could not be asked which context windows this model offers',
      unavailableKind: 'unreadable',
      exact: false,
    };
  }

  /**
   * Narrow the superset to what one model's handshake enumerated.
   *
   * Three answers, and the split is the point:
   * - the reply named this option → its values, in the agent's own order;
   * - the reply enumerated options and NOT this one → genuinely none, with the
   *   model named in the reason, since a picker that silently disappears reads
   *   as broken;
   * - anything else (the probe failed, the agent enumerated nothing) → the
   *   superset. Silence is not a refusal, the rule every reader in this
   *   transport follows.
   */
  private readEffortProbe(
    stdout: string | null,
    model: string,
    superset: AgentEffortListing,
  ): AgentEffortListing {
    if (stdout === null) {
      return superset;
    }
    // EVERY spelling, because the axis is named by the model rather than by the
    // CLI: `gpt-5.2` enumerates `reasoning` where `grok-4.6` enumerates
    // `effort`. Reading only the first name left the OpenAI family with no
    // picker at all — and, before the driver learned to resolve the id, with a
    // control that could not have worked if it had one.
    for (const id of CURSOR_EFFORT_PARAMETER_IDS) {
      const option = readAcpConfigOptionProbe(stdout, id);
      if (option !== null && option.options.length > 0) {
        return {
          efforts: option.options.map(({ value, name }) => ({
            id: value,
            label: name,
          })),
          unavailableReason: null,
          exact: true,
        };
      }
    }
    if (!acpProbeEnumeratedConfigOptions(stdout)) {
      return superset;
    }
    return {
      efforts: [],
      unavailableReason: `${model} has no reasoning-effort setting — pick a model that does, or run it at its own default.`,
      // The agent enumerated its options and this model's axis was not among
      // them, which is an answer about the model rather than a failure to ask.
      exact: true,
    };
  }

  private readModelProbe(stdout: string | null): AgentModel[] {
    if (stdout === null) {
      // A failed probe is an unknown vocabulary, not an empty one. Returning
      // [] is what the picker renders as "default model only", which is the
      // honest reading of "we could not ask".
      return [];
    }
    // The ids come back BARE now (`claude-opus-5`, not the bracketed form) —
    // the probe speaks the same parameterized handshake a turn does, so what the
    // picker stores is what a turn can apply. That is also why no effort is read
    // out of an id here any more: on this transport the effort is its own control.
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

  /**
   * Dial ONE server, so a row the user just switched on can say what it found.
   *
   * `mcp list-tools <server>` is the only per-server command this CLI has, and
   * listing a server's tools requires connecting to it — which makes it a health
   * probe with a folder listing's meaning at a fraction of its cost
   * ({@link CURSOR_MCP_TOOLS_ARGS} carries the timings and the captured output).
   *
   * `processGroup` because it DIALS: a stdio server is launched as a grandchild
   * of this command, and a single-PID kill would leave it running. `captureDiagnosis`
   * because the two readings worth telling apart — needs signing in, versus
   * broken — both exit 1 and both write to stderr, so the usual null-on-failure
   * would collapse them into each other.
   *
   * Never throws: an unreadable answer is null, and the caller leaves the row's
   * health unstated rather than inventing one.
   */
  override async readMcpServerHealth(
    input: AgentMcpServerHealthInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpServerHealth | null> {
    const output = await this.runCommand(
      [...CURSOR_MCP_TOOLS_ARGS, input.server],
      {
        ...options,
        cwd: input.cwd,
        processGroup: true,
        captureDiagnosis: true,
        timeoutMs: options.timeoutMs ?? CURSOR_MCP_TOOLS_TIMEOUT_MS,
      },
    );
    return parseCursorToolsProbe(output);
  }

  /**
   * Where this folder's servers were defined, and what cursor's own app loads
   * on top of them.
   *
   * The two lists this method is named for stay EMPTY here, and that is
   * unchanged: cursor reports a switched-off server as `disabled` in the
   * listing itself, and `mcp enable` undoes the only state its switch writes,
   * so there is no disabled set to read and nothing locked off. What the
   * listing genuinely cannot say is which SCOPE a row came from — it merges the
   * two files by name and prints one row each — which is the whole reason this
   * override now exists.
   *
   * Read-only and best-effort throughout: every file here belongs to the user,
   * and an unreadable one costs a label rather than the listing.
   */
  override async readMcpFolderFacts(cwd: string): Promise<AgentMcpFolderFacts> {
    const home = this.cursorOptions.homeDir ?? homedir();
    const cursorHome = join(home, CURSOR_HOME_DIR_NAME);
    const [user, workspace] = await Promise.all([
      readFileSafe(join(cursorHome, CURSOR_MCP_CONFIG_NAME)),
      readFileSafe(
        join(
          cursorProjectRoot(cwd),
          CURSOR_HOME_DIR_NAME,
          CURSOR_MCP_CONFIG_NAME,
        ),
      ),
    ]);
    const userNames = parseMcpServerNames(user);
    const workspaceNames = parseMcpServerNames(workspace);
    return {
      // The union of the two files this CLI merges, deduped BY NAME because
      // that is how the CLI itself merges them — a name defined at both scopes
      // is one server, which is the same collapse `origins` describes.
      configured: [...new Set([...userNames, ...workspaceNames])],
      disabled: [],
      lockedOff: [],
      origins: mcpOrigins(userNames, workspaceNames),
      interactiveOnlyNote: pluginOnlyNote(
        await this.readPluginServerNames(cursorHome),
      ),
    };
  }

  /**
   * The servers this machine's installed plugins declare, by name.
   *
   * Two files per plugin, because the manifest only POINTS at its MCP config
   * (`"mcpServers": "./.dd_cursor_mcp.json"`). The scan is depth-bounded (see
   * {@link CURSOR_PLUGIN_SCAN_DEPTH}) — the plugin cache holds a checkout per
   * plugin, and this runs on a listing the panel waits for.
   *
   * Every manifest shape the skills walk accepts
   * ({@link CURSOR_PLUGIN_MANIFEST_PATHS}), not just cursor's own: a plugin
   * carrying one of the other two contributed skills and no servers, so the
   * note omitted servers the user can see working in Cursor. This still walks
   * the broader `plugins/` root rather than the skills walk's `plugins/cache`,
   * which is deliberate — `descendants` reaches the same version directories
   * AND `plugins/local`, which that narrower root does not.
   */
  private async readPluginServerNames(cursorHome: string): Promise<string[]> {
    const names: string[] = [];
    const root = join(cursorHome, CURSOR_PLUGINS_DIR_NAME);
    for (const dir of await descendants(root, CURSOR_PLUGIN_SCAN_DEPTH)) {
      for (const manifest of CURSOR_PLUGIN_MANIFEST_PATHS) {
        const relative = parsePluginMcpPath(
          await readFileSafe(join(dir, ...manifest)),
        );
        if (relative === null) {
          continue;
        }
        // Resolved against the PLUGIN's own directory, which is `dir` itself —
        // a pointer like `./.dd_cursor_mcp.json` is written relative to the
        // plugin, not to the manifest beside it. Taking the manifest's
        // grandparent instead would land one level too high for the bare
        // `plugin.json` shape, which sits AT the plugin root.
        names.push(
          ...parseMcpServerNames(await readFileSafe(join(dir, relative))),
        );
      }
    }
    return names;
  }

  /**
   * Switch one server for one folder by driving the CLI's own subcommand.
   *
   * `cursor-agent mcp enable|disable <name>`, run IN that folder — the CLI
   * resolves its own per-project state from `process.cwd()` (its git root, else
   * the folder itself), so the cwd is the whole scoping mechanism and geniro
   * never has to name the file. {@link CURSOR_MCP_ENABLE_ARGS} carries the
   * bundle source and the measurements, including why the old "this is global"
   * reading was wrong.
   *
   * NOT `processGroup`, unlike the listing beside it: neither subcommand dials
   * anything — disable is a read-modify-write of one small JSON file, and
   * enable additionally reads the two `mcp.json` files and the approvals list —
   * so there is no grandchild to reap and the plain path's own deadline is the
   * right one.
   *
   * A null stdout is the command having failed, which for the ON direction is a
   * real refusal the panel should show (a server no config defines exits 1). The
   * OFF direction cannot fail that way — measured, `mcp disable` exits 0 on any
   * name at all — so nothing here has to distinguish them.
   */
  override async setMcpServerEnabled(
    cwd: string,
    server: string,
    enabled: boolean,
    options: AgentCommandOptions = {},
  ): Promise<void> {
    const stdout = await this.runCommand(
      [...(enabled ? CURSOR_MCP_ENABLE_ARGS : CURSOR_MCP_DISABLE_ARGS), server],
      { ...options, cwd },
    );
    if (stdout === null) {
      // Thrown, not returned: the contract is a promise that REJECTS on a
      // refusal, and `AgentMcpService` turns the message into the sentence the
      // panel renders instead of moving the switch.
      throw new Error(CURSOR_MCP_TOGGLE_FAILED_MESSAGE);
    }
  }

  /** Raw-handshake cache shared by both model-config listings above. */
  /**
   * The RAW handshake reply behind both model-vocabulary listings, keyed and
   * version-checked by the SHARED cache rather than a private copy of it —
   * `.claude/rules/daemon-module-structure.md`: "Cross-module logic is
   * extracted, never mirrored." The `kind` dimension is a constant here (there
   * is only ever one `cursor-agent` to ask), which costs one argument and buys
   * a single home for the single-flight and freshness rules.
   */
  private readonly handshakeProbeCache = new ModelVocabularyCache<
    string | null | undefined
  >({ ttlMs: CURSOR_HANDSHAKE_PROBE_TTL_MS, now: Date.now });

  /** The durable half of that cache — see {@link probeModelConfigOptionsShared}. */
  private readonly vocabularyStore: ModelVocabularyStore;

  constructor(private readonly cursorOptions: CursorAcpAdapterOptions) {
    super(cursorOptions);
    // Assigned in the BODY rather than as a field initializer: an initializer
    // reading `cursorOptions` depends on when the parameter property is
    // assigned relative to it, which is a compiler detail rather than a
    // guarantee.
    this.vocabularyStore = cursorOptions.vocabularyStore;
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
   * What this CLI's own accounting says the window holds, read out of the
   * session store it keeps on disk.
   *
   * NOT from the process, and it could not be: a cursor turn is one process
   * ({@link canHostSession}), so by the time anyone opens a readout there is
   * nothing running to ask. That is the whole reason
   * {@link AgentSessionReadInput} carries a session id beside a live session
   * — this adapter uses only the id.
   *
   * The figures are the CLI's OWN, not an estimate: it writes a full
   * per-category breakdown for every turn, which is what its own TUI renders.
   * The parser, the probe evidence and the expiry warning are in
   * `utils/cursor-context-store.utils.ts`.
   *
   * Reading is READ-ONLY and failure-swallowing by construction. This is
   * another program's private store — geniro already owns the directory (the
   * per-turn profile symlinks into it) but not the format — so every way it
   * can go wrong (no session yet, no file, a schema that has moved, a locked
   * database) is one answer: null, and the panel says the breakdown could not
   * be taken.
   */
  override readContextUsage(
    input: AgentSessionReadInput,
  ): Promise<AgentContextUsage | null> {
    return Promise.resolve(
      input.sessionId ? this.readSessionContext(input.sessionId) : null,
    );
  }

  /**
   * One session's breakdown off this CLI's own store — the single place that
   * knows where that file is.
   *
   * TWO readers, which is why it is a method rather than the body of
   * {@link readContextUsage}: the readout asks it on demand, and the turn
   * driver asks it per turn to feed the meter's ring (`readContext` in
   * `createTurnDriver`). Both are the same question about the same file, and a
   * second copy of the path join is a second thing to get wrong.
   */
  private readSessionContext(sessionId: string): AgentContextUsage | null {
    // The same guard its twin below applies, and for the same reason: the id
    // reaches a path as a DIRECTORY component. It is the AGENT's own string —
    // `node_state.agentSessionId` is written from the CLI's `session/new` reply
    // — so a separator in it points this read-only SQLite open outside the
    // store. Both readers of `sessionStoreDir()` now pass through here.
    if (!isPlainSessionId(sessionId)) {
      return null;
    }
    const path = join(
      this.sessionStoreDir(),
      sessionId,
      CURSOR_SESSION_STORE_DB_NAME,
    );
    // A store that does not exist yet is the NORMAL state of a conversation's
    // first turn — the CLI writes it when it first accounts for the window — so
    // it is answered here rather than handed to the reader, which would say so
    // out loud. That warning is worth keeping for a store geniro genuinely
    // failed to read, and worthless once it fires for every new chat: the turn
    // driver now takes a reading per turn, and a channel that warns when
    // nothing is wrong is one people learn to skip.
    return existsSync(path) ? readCursorContextUsage(path, this.warn) : null;
  }

  /**
   * The title this agent gave the conversation, off the same store the
   * breakdown comes from.
   *
   * TRUSTWORTHY BECAUSE THE PROMPT SAYS WHAT IT IS, which it did not always.
   * This CLI names a session from its first prompt, and on ACP that prompt also
   * carries geniro's own host instructions — read as the user speaking, they
   * became what the name described: a chat opened with `Hello!` was called
   * `Geniro Markdown Display`. Wrapping them as host context
   * (`AcpTurnDriver.composePrompt`) fixed that at its source, so this read is
   * worth having again rather than replaced by a spawn. Measured after, on
   * three openings the bare concatenation had ruined: `Bloom Filter Explained`,
   * `Hello Chat`, `Hello There`.
   *
   * Read from geniro's OWN session directory rather than asked over ACP
   * `session/list`: the agent writes the title into `meta.json` as it goes, and
   * the caller already holds the session id, so the protocol route would spawn a
   * `cursor-agent acp` process to re-read a file this app's own turns just
   * wrote.
   *
   * Absent until the agent has named the conversation — a first turn routinely
   * has no title yet, and a very short exchange may never get one — which is an
   * ordinary null the caller answers with the derived title.
   */
  override readSessionTitle(sessionId: string): Promise<string | null> {
    if (!isPlainSessionId(sessionId)) {
      return Promise.resolve(null);
    }
    const path = join(
      this.sessionStoreDir(),
      sessionId,
      CURSOR_SESSION_META_NAME,
    );
    // Same silence as the breakdown's store: absent is the normal state of a
    // new conversation, so it is answered here rather than warned about.
    return Promise.resolve(
      existsSync(path) ? readCursorSessionTitle(path, this.warn) : null,
    );
  }

  /** The adapter's own warn, as a value the readers above can be handed. */
  private readonly warn = (message: string): void =>
    this.options.logger?.warn(message);

  /**
   * No one-shot payload — the driver writes the opening `initialize` frame
   * from `onStdinReady`, and everything after it is a reply to the agent.
   */
  protected override buildStdinPayload(
    _input: AgentTurnInput,
  ): string | undefined {
    return undefined;
  }

  /**
   * Re-inject the USER's own inherited `CURSOR_API_KEY` for this child only.
   *
   * geniro no longer has a key of its own to hand over — the Keychain entry,
   * the `GENIRO_CURSOR_API_KEY` hop and the secret IPC surface were all removed
   * once `cursor-agent` was confirmed to authenticate from its own `~/.cursor`
   * login (probed 2026-08-12 on 2026.08.04-aaa8809: `status` reports the account
   * with no such variable anywhere in the environment). So the ONLY key that can
   * appear here is one the user exported in the shell that launched the app.
   *
   * It still has to be re-injected rather than simply left un-stripped, and that
   * is the whole reason this override survived the removal: `buildChildEnv`
   * strips the name from EVERY child, so leaving it out of the strip set would
   * pass the user's Cursor credential to the claude agent too. Sourcing it here
   * keeps "no spawned agent inherits another agent's credential" true while a
   * user who authenticates by env var keeps working.
   *
   * `input.env` wins, so an explicit per-call override still governs. WHICH
   * names are carried is `auth.inheritedEnvKeys`, read by the base — this
   * override exists only to fold `input.env` over them for a turn.
   *
   * **One honest limit, which no plumbing here fixes.** A PACKAGED app launched
   * from Finder inherits launchd's environment, not the user's shell, so an
   * exported `CURSOR_API_KEY` never reaches this process at all — the daemon is
   * spawned with a spread of `process.env` (`DaemonSupervisor.spawnDaemon`) and
   * only `PATH` is resolved through a login shell. So env-var auth is a
   * `pnpm dev` capability, and `cursor-agent login` is the supported route in a
   * shipped build. Say that rather than implying otherwise.
   */
  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    const profile = this.turnProfiles.get(input);
    return {
      ...this.inheritedEnv(),
      // Runs BEFORE `input.env`, deliberately: a caller that names its own
      // config directory (a node pointed at a profile) must win over the
      // throwaway one, or the feature would be silently disabled by this.
      ...(profile ? { [CURSOR_CONFIG_DIR_ENV]: profile } : {}),
      ...input.env,
    };
  }

  /** Per-turn config directory paths, created by `prepareTurn`. */
  private readonly turnProfiles = new WeakMap<AgentTurnInput, string>();

  /**
   * Give the turn its own `CURSOR_CONFIG_DIR`, seeded from the user's.
   *
   * This exists because applying a model or an effort over ACP WRITES the config
   * directory — so without it, a chat's model choice changes what the user's own
   * `cursor-agent` opens with. `utils/cursor-profile.utils.ts` carries the
   * measurements, including why only `cli-config.json` is copied.
   *
   * The CONVERSATION is the one thing that must outlive the turn, so the profile
   * links `acp-sessions` at a shared store instead of holding its own: the CLI
   * keeps each thread inside its config directory, and the first version of this
   * therefore deleted every chat as it settled — the next message failed at
   * `session/load`. See the utils doc for both measurements.
   *
   * The base runs the returned disposer on exactly one settle path, so the
   * directory is removed once however the turn ends.
   *
   * It also OPENS the handshake on the turn's own model, and that is a
   * correctness change rather than a saving. A `session/new` reply describes
   * the CURRENT model — its config options, and so which reasoning axis it has
   * and what values that axis takes — so a session opened on the user's default
   * and switched afterwards describes the model being switched AWAY from, and
   * the driver can check nothing about the one the turn will actually run on.
   * Seeded, the reply describes the right model from the first frame, which is
   * what lets `applyModelParameters` refuse a level locally and resolve an axis
   * this model spells differently (`gpt-5.2` calls it `reasoning`).
   *
   * It is also strictly less work: `readAcpCurrentModelId` then matches, so the
   * `session/set_config_option` model frame is skipped — a round trip measured
   * at 2.2–3.0s on every turn that names a model.
   *
   * Safe in BOTH failure directions, probed 2026-08-19 on 2026.08.11-e8db854:
   * a valid model comes back as the reply's `currentValue`, and a name the CLI
   * does not know does NOT fail the handshake — it answers with `auto-smart`
   * as current, so the id does not match, the driver sends the model frame, and
   * the turn behaves exactly as it did before this.
   */
  protected override prepareTurn(
    input: AgentTurnInput,
  ): (() => void) | undefined {
    const dir = seedCursorProfile({
      baseDir: this.profileBaseDir(),
      sessionStoreDir: this.sessionStoreDir(),
      homeDir: this.cursorOptions.homeDir,
      // The BARE name: a legacy stored id carries its parameters in brackets,
      // and `cli-config.json` names a model, not a variant.
      ...(splitCursorModelId(input.model).model
        ? { model: splitCursorModelId(input.model).model! }
        : {}),
      // Max Mode — the user's own setting, snapshotted onto the run and
      // carried here; {@link CURSOR_MAX_MODE} is what a turn that says nothing
      // gets, and {@link CURSOR_MAX_MODE_CONFIG_KEY} holds the measurements.
      // `??` and not `||`: `false` is a real choice, and the default is only
      // for a caller that did not speak. Written EXPLICITLY either way, never
      // left to the copied config — an untouched key means "however the user's
      // own terminal was last left", so OFF has to be written as much as ON.
      maxMode: input.cursorMaxMode ?? CURSOR_MAX_MODE,
    });
    this.turnProfiles.set(input, dir);
    return () => {
      this.turnProfiles.delete(input);
      removeCursorProfile(dir);
    };
  }

  /**
   * The conversations this CLI holds, asked of the CLI over ACP `session/list`.
   *
   * Read under a THROWAWAY profile whose `acp-sessions` is linked at the store
   * being listed — the user's own — for the same reason every other cursor
   * invocation gets one: a handshake writes into its config directory, and a
   * listing must not change what the user's `cursor-agent` opens with.
   *
   * The store it points at is deliberately NOT geniro's own. geniro's store
   * holds the threads this app already created, which are already in the
   * sidebar; what a user means by "resume an old session" is the one their
   * terminal made. An id from there is not resumable until it is brought
   * across, which is exactly what {@link prepareSessionImport} does.
   *
   * Never throws: a missing binary, a signed-out CLI or a `-32601` from an agent
   * that does not implement the method all come back as an empty list. That is
   * safe here in a way it would not be for the MCP panel, because a cursor
   * listing has a second half — `sessions.listingPartialReason` — that already
   * tells the user this list is not everything they have.
   */
  override async listSessions(
    input: AgentSessionsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentSessionListing> {
    let cwd = '';
    let profile = '';
    try {
      cwd = this.makeProbeRoot('sessions');
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        sessionStoreDir: this.userSessionStoreDir(input.configDir),
        homeDir: this.cursorOptions.homeDir,
      });
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        // The probe root, never `input.cwd`: the FILTER travels in the
        // `session/list` params, and rooting the server at the user's folder
        // would have it trust and scan a directory to answer a question about
        // conversations.
        cwd,
        stdinWrites: acpSessionListFrames({
          cwd: input.cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpSessionListSettled,
        env: { [CURSOR_CONFIG_DIR_ENV]: profile },
        timeoutMs: options.timeoutMs ?? CURSOR_SESSION_LIST_TIMEOUT_MS,
      });
      return {
        sessions:
          stdout === null
            ? []
            : // Narrowed HERE and not by the caller. Every implementation of
              // this method has to apply the query itself, or a search would
              // silently widen back to the whole list on whichever CLI forgot —
              // and this one can only reach what `session/list` returned, which
              // is why it declares `contentSearchUnavailableReason`.
              matchSessions(readAcpSessionList(stdout), input.query).slice(
                0,
                input.limit,
              ),
        unavailableReason: null,
        partialReason: null,
      };
    } catch {
      return { sessions: [], unavailableReason: null, partialReason: null };
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * Bring one conversation across into the store geniro's turns resume from.
   *
   * A COPY is what this CLI needs and claude does not: geniro's turns run under
   * a throwaway profile whose `acp-sessions` is a symlink to its own store, so a
   * session sitting in the user's profile is simply not there as far as
   * `session/load` is concerned. Probed 2026-08-16 on 2026.08.11-e8db854, both
   * directions — the id answers `-32602 … not found` before the copy, and after
   * it loads and replays its entire transcript.
   *
   * A session already in geniro's store is left ALONE rather than overwritten:
   * the same id can be imported twice, and the second import must not put a
   * stale copy over the turns this app has since added to it.
   *
   * Throws when the source is not there, because the alternative is a thread
   * whose first turn fails on a session the CLI cannot find — a failure the user
   * would meet one message later with nothing connecting it to the import.
   *
   * The copy is STAGED beside the store and renamed into place, mirroring
   * `utils/atomic-file.ts` one level up at directory granularity. A `cp` that
   * dies partway — ENOSPC, EACCES, the daemon SIGKILLed — otherwise leaves a
   * populated directory at the destination, and the `existsSync` guard above
   * then short-circuits onto it for good: every later import of that id returns
   * at once, `session/load` replays a truncated store, and that conversation's
   * history is permanently lost with only a notice to show for it. Staging is
   * what makes the destination appear whole or not at all.
   */
  override async prepareSessionImport(
    input: AgentSessionImportInput,
  ): Promise<void> {
    // BEFORE any join. The id reaches three paths here — the source read from
    // the user's own profile, the destination, and a staging directory the
    // `finally` below removes recursively — so a separator in it walks all
    // three out of the directories they name. Refused here as well as at the
    // service seam because this method is reachable without that service.
    if (!isPlainSessionId(input.sessionId)) {
      throw new Error(SESSION_ID_INVALID_MESSAGE);
    }
    const store = this.sessionStoreDir();
    const from = join(
      this.userSessionStoreDir(input.configDir),
      input.sessionId,
    );
    const to = join(store, input.sessionId);
    if (existsSync(to)) {
      return;
    }
    if (!existsSync(from)) {
      throw new Error(CURSOR_SESSION_MISSING_MESSAGE);
    }
    await mkdir(store, { recursive: true });
    // Beside the destination, because a rename is only atomic within one
    // filesystem — and under a name no concurrent import could pick.
    const staging = join(
      store,
      `.${input.sessionId}.${process.pid}.${process.hrtime.bigint()}.tmp`,
    );
    try {
      // Belt-and-braces on a path that cannot pre-exist: the `pid`+`hrtime`
      // suffix already makes `staging` unique. The flags are kept as the honest
      // spelling of "never merge into an existing directory" — `force: false`
      // alone does not give that, since probed on node v24 it merges per entry
      // with the default `errorOnExist: false`, neither raising nor
      // overwriting. That probe is what the destination guard below rests on.
      await cp(from, staging, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      // A directory that appeared between the guard above and here makes this
      // fail with ENOTEMPTY rather than replacing a live conversation.
      await rename(staging, to);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The conversation itself, taken from the agent by LOADING it and reading
   * what it replays.
   *
   * This CLI keeps its transcript in a private per-session SQLite store whose
   * blobs are protobuf — geniro reads one block of it for the context meter and
   * has no business reading the rest — but ACP hands the whole conversation
   * back for free: `session/load` streams every message, thought and tool call
   * as `session/update` notifications before it replies. So the record is read
   * through the protocol rather than through the file, which also means a
   * change to that file's encoding costs nothing here.
   *
   * Run under a profile linked at GENIRO's store, deliberately, and therefore
   * only after {@link prepareSessionImport} has brought the session across:
   * loading it under the user's own profile would be the copy's job done twice
   * and would leave the imported thread depending on a store geniro does not
   * own.
   *
   * `cwd` is the session's own, which the caller took from the listing — a load
   * roots the agent somewhere, and rooting a conversation about one project in
   * another is how a resumed thread starts reasoning about the wrong tree.
   */
  override async readSessionHistory(
    input: AgentSessionImportInput & { limit: number },
  ): Promise<AgentSessionHistory | null> {
    let profile = '';
    try {
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        sessionStoreDir: this.sessionStoreDir(),
        homeDir: this.cursorOptions.homeDir,
      });
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        cwd: input.cwd,
        stdinWrites: acpSessionLoadFrames({
          sessionId: input.sessionId,
          cwd: input.cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpSessionLoadSettled,
        env: { [CURSOR_CONFIG_DIR_ENV]: profile },
        timeoutMs: CURSOR_SESSION_LOAD_TIMEOUT_MS,
      });
      if (stdout === null) {
        // The load failed or timed out. Null is "no readable record", which the
        // caller turns into a thread that resumes correctly and simply opens
        // empty — never into a failed import, because the SESSION is fine and
        // only its transcript could not be fetched.
        return null;
      }
      const events = readAcpSessionReplay(stdout);
      const droppedBefore = Math.max(0, events.length - input.limit);
      return { events: events.slice(droppedBefore), droppedBefore };
    } catch {
      return null;
    } finally {
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * Where the USER's own ACP conversations live — `<configDir>/acp-sessions`,
   * or `~/.cursor/acp-sessions` when the run names no profile.
   *
   * Distinct from {@link sessionStoreDir}, which is geniro's, and the two must
   * never be confused: one is read to offer an import, the other is written by
   * every turn.
   */
  private userSessionStoreDir(configDir: string | null): string {
    return join(
      configDir ??
        join(this.cursorOptions.homeDir ?? homedir(), CURSOR_HOME_DIR_NAME),
      CURSOR_ACP_SESSIONS_DIR_NAME,
    );
  }

  private profileBaseDir(): string {
    return (
      this.cursorOptions.profileDir ?? join(tmpdir(), CURSOR_PROFILE_DIR_NAME)
    );
  }

  private sessionStoreDir(): string {
    return (
      this.cursorOptions.sessionStoreDir ??
      join(tmpdir(), CURSOR_SESSION_STORE_DIR_NAME)
    );
  }

  /**
   * Drop the per-turn profiles a prior daemon launch left behind. Called once at
   * boot; only a SIGKILLed daemon can leave any, since the disposer covers every
   * ordinary settle path.
   */
  sweepStaleProfiles(): void {
    sweepStaleCursorProfiles(this.profileBaseDir());
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
      composeSystemPrompt: (granted, includePreamble) =>
        this.composeSystemPrompt(input, granted, includePreamble),
      clientName: CURSOR_ACP_CLIENT_NAME,
      clientVersion: this.clientVersion,
      // What unlocks the separate effort control; see CURSOR_ACP_CLIENT_META.
      clientMeta: CURSOR_ACP_CLIENT_META,
      // The stored id split into a bare model plus its parameters, with this
      // turn's own effort applied over whatever the id carried. Composed here
      // because the bracket syntax is this CLI's, and the driver must not learn
      // to read one.
      modelSelection: cursorModelSelection(
        input.model,
        input.effort,
        input.contextWindow,
        input.modelParameters,
      ),
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
      delegate: {
        method: CURSOR_TASK_METHOD,
        launchMarker: CURSOR_TASK_LAUNCH_MARKER,
        read: readCursorTask,
        // The `task` call returns `{durationMs, isBackground}` and nothing the
        // delegate said — see the field's own doc block for what that looked
        // like framed as its answer.
        resultIsBookkeeping: true,
        stepsUnavailableReason:
          this.getConfig().subagents.stepsUnavailableReason,
      },
      todos: {
        method: CURSOR_TODOS_METHOD,
        read: parseCursorTodos,
      },
      // This CLI catches its own failure, writes the sentence out as an
      // assistant message and answers `end_turn` regardless — so without this
      // a turn that died on `RetriableError: [unavailable] PING timed out`
      // rendered that line as the agent's own prose under a `✓ done · 1m 14s`
      // footer. REPORTED with exactly that screenshot. The reader's doc block
      // carries the catch block it was read out of and why matching it is
      // sound.
      agentFailure: { read: readCursorAgentFailure },
      // The SAME store the readout reads, put on the turn's event stream — and,
      // through it, onto the turn's own `turn_complete` — so the meter's ring is
      // drawn from it too. ACP carries no context accounting at all, so before
      // this the ring had no reading and rendered hollow while the panel behind
      // it showed a full breakdown off this very file — the reported "the number
      // says 51% and the circle is not filled at all". Two readings of one
      // source cannot disagree; a reading and a blank can.
      //
      // Reported AGAIN after the first pass, and the second half is why: a
      // reading rides the ephemeral live plane, which the client drops when the
      // run settles, so the ring was fed for the length of a turn and blank
      // between turns — which is when anybody is looking at it. The durable
      // half is `AcpTurnDriver.buildUsage`, which now reads the same reading.
      // Measured end to end on a real turn: `{contextTokens: 42970,
      // contextWindowTokens: 200000}` in the row, against `inputTokens: null`
      // beside it — the row could only have got those from here.
      readContext: (sessionId) => {
        const usage = this.readSessionContext(sessionId);
        return usage === null
          ? null
          : {
              usedTokens: usage.totalTokens,
              windowTokens: usage.maxTokens,
              model: usage.model,
            };
      },
      logger: this.cursorOptions.logger,
    });
  }

  /**
   * This adapter's own memory of the handshake — the one cache no service can
   * reach, since three listings share it through
   * {@link probeModelConfigOptionsShared}.
   *
   * The DURABLE half is `ModelVocabularyStore`'s and is cleared by the same
   * service, not from here: this adapter holds one of two references to that
   * store, and clearing it here would leave the models listing's copy standing.
   */
  override clearCaches(): number {
    return this.handshakeProbeCache.clear();
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

/**
 * What a stored handshake reply has to look like to be served back.
 *
 * `ModelVocabularyStore` holds JSON and cannot know what any of it means, so
 * the shape check belongs to whoever filed the value. Deliberately weak — this
 * is the CLI's raw stdout, so the only thing knowable about it here is that it
 * is text somebody wrote; whether it PARSES is the readers' question, and they
 * each already answer it with their own three-way split.
 */
function isProbeReply(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
