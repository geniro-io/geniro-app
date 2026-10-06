import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { AgentKind } from '../../../runs/runs.types';
import { adapterQuestionOf } from '../../utils/card-questions';
import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import {
  ModelVocabularyCache,
  volatile,
} from '../../utils/model-vocabulary-cache';
import type {
  AdapterConfig,
  AdapterDaemonDeps,
  AdapterQuestion,
  AgentCommandOptions,
  AgentEffortListing,
  AgentMcpListingResult,
  AgentMcpServersInput,
  AgentModel,
  AgentModelsInput,
  AgentPlanLimits,
  AgentReportedCommand,
  AgentSessionHistory,
  AgentSessionImportInput,
  AgentSessionListing,
  AgentSessionReadInput,
  AgentSessionsInput,
  AgentTitleInput,
  AgentTurnInput,
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
  TurnDriver,
} from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import { matchSessions } from '../utils/session-search.utils';
import { readTitleAnswer, titlePrompt } from '../utils/title-prompt.utils';
import {
  CODEX_ACCOUNT_ENV_KEYS,
  CODEX_APP_SERVER_ARGS,
  CODEX_AUTO_COMPACT_KEY,
  CODEX_COMPACT_PROMPT,
  CODEX_CONFIG_FLAG,
  CODEX_CREDENTIAL_ENV_KEYS,
  CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC,
  CODEX_HOME_ENV,
  CODEX_MCP_ENABLED_FIELD,
  CODEX_MCP_LIST_ARGS,
  CODEX_METHODS,
  CODEX_MODELS_TTL_MS,
  CODEX_ONESHOT_TIMEOUT_MS,
  CODEX_PLAN_LIMITS_TIMEOUT_MS,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SESSION_SEARCH_PAGE,
  CODEX_THREAD_ID_PATTERN,
  CODEX_TITLE_ARGS,
  CODEX_TITLE_TIMEOUT_MS,
  CODEX_UNSAFE_SERVER_NAME,
} from './codex.const';
import { CodexSession } from './codex-session';
import type { CodexTurnOptions } from './codex-turn.driver';
import {
  codexCardQuestions,
  withCodexAnswer,
} from './utils/codex-approval.utils';
import { codexMcpServerKey, parseCodexMcpList } from './utils/codex-mcp.utils';
import {
  type CodexModelEntry,
  readCodexModels,
} from './utils/codex-models.utils';
import {
  codexOneshotFrames,
  codexOneshotReply,
  codexOneshotSettled,
} from './utils/codex-oneshot.utils';
import {
  codexPlanLimitsRequestLine,
  readCodexPlanLimitsReply,
} from './utils/codex-plan-limits.utils';
import { codexTurnPolicy } from './utils/codex-policy.utils';
import {
  codexThreadHistory,
  readCodexThreads,
} from './utils/codex-threads.utils';

/** Options the codex adapter accepts — the base's, with nothing of its own. */
export type CodexAdapterOptions = AgentAdapterOptions;

/**
 * OpenAI's Codex CLI, driven over its own `codex app-server` — stdio JSON-RPC
 * with one process per conversation, the same shape as the ACP transport.
 * codex ships no ACP server (checked on 0.157.1: no such subcommand, and the
 * app-server protocol is what its own IDE extension speaks), so this is its
 * first-party headless protocol; revisit if it grows one.
 */
export class CodexAdapter extends AgentAdapter {
  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.Codex,
      identity: {
        displayName: 'Codex',
        shortName: 'codex',
        summary:
          'OpenAI Codex CLI, driven headlessly through codex app-server.',
        details: [
          'Runs each node as a codex conversation over its app-server protocol.',
          'Tool approvals are per-node — auto, ask, accept edits, or plan.',
          'Model and reasoning effort are chosen per node (empty = the CLI default).',
          'Signs itself in with your ChatGPT account or an API key — no key to enter here.',
        ],
        icon: 'code',
      },
      autoCompact: {
        kind: 'config-override',
        flag: CODEX_CONFIG_FLAG,
        key: CODEX_AUTO_COMPACT_KEY,
        // Below this there is nothing to compact: a fresh codex thread already
        // holds ~16k tokens of its own instructions (measured on 0.157.1).
        minTokens: 1_000,
      },
      shells: {
        // Every command is an item codex opens and closes itself.
        unreportedDetachReason: null,
      },
      questionToolName: CODEX_QUESTION_TOOL_NAME,
      // A question arrives as a server request whatever the approval policy.
      questionsCostAskPosture: false,
      hostQuestionToolReason:
        'codex gives its model a question tool (request_user_input) only in plan mode — outside it the feature flag default_mode_request_user_input is off (measured on 0.157.1)',
      // geniro sets the tool timeout on its own server entry to a day, so a
      // question can wait on screen until it is answered.
      hostQuestionDeferredReason: null,
      subagents: {
        reports: true,
        unavailableReason: null,
        // Its ending arrives as that sub-agent thread's own `turn/completed`,
        // on the same app-server stream — also after the parent's turn has
        // ended, which is what lets a delegate that outlives the turn close
        // with its real outcome instead of being closed by the turn.
        stepsUnavailableReason: null,
        // A sub-agent arrives as `subAgentActivity`, which the daemon declares
        // as a `subagent_info` row; nothing admits it by a tool name.
        launchToolNames: [],
      },
      // `CODEX_TOOL_NAMES` is every tool this adapter maps, and none publishes
      // an artifact.
      artifactToolNames: [],
      approval: {
        modes: ['auto', 'ask', 'acceptEdits', 'plan'],
        probedModes: [],
        degradeOnProbeFail: {},
        soleModeDegradeReason: null,
      },
      // The union `model/list` offered across one account's models (0.157.1);
      // each model narrows it — see `listModelEfforts`.
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'xhigh' },
        { id: 'max', label: 'max' },
        { id: 'ultra', label: 'ultra' },
      ],
      effortsUnavailableReason: null,
      options: [],
      resumeOnlyUnavailableReason: null,
      effortsAreExhaustive: false,
      contextWindowsUnavailableReason:
        'codex runs each model at its one window — model/list offers no choice of size',
      builtinModels: [],
      skillRoots: {
        profileAnchor: null,
        skills: [
          ['.codex', 'skills'],
          ['.agents', 'skills'],
        ],
        commands: [],
        plugins: [],
      },
      liveStream: null,
      // Answered by `skills/list` instead of a probe turn — see
      // `listReportedCommands`.
      reportedCommands: null,
      geniroCommands: [
        {
          name: 'compact',
          description:
            'Compact the conversation so far — codex summarises it and carries on in the same thread',
          prompt: CODEX_COMPACT_PROMPT,
          replacesSession: false,
        },
      ],
      mcp: {
        callToolsRequireTrustProbe: false,
        endpointRequiresCwdConfig: false,
        listingUnavailableReason: null,
        toggleUnavailableReason: null,
        interactiveOnlyNote: null,
        userDisabledReason:
          'switched off in codex’s own config (`enabled = false` under its entry)',
        loginArgs: ['mcp', 'login'],
        loginFailureMarkers: [],
        loginUnavailableReason: null,
        approveUnavailableReason:
          'codex loads every configured MCP server without asking for approval first',
        /**
         * The figure geniro SETS rather than one it measured: the thread config
         * carries a day-long `tool_timeout_sec` on geniro's entry alone
         * (`CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC`), so no call wait is cut by this
         * CLI's own client inside a day and the graph runtime's own ceiling on a
         * wait is what binds.
         */
        toolCallDeadlineMs: CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC * 1000,
      },
      auth: {
        loginArgs: ['login'],
        loginUnavailableReason: null,
        logoutArgs: ['logout'],
        logoutUnavailableReason: null,
        loginCodePromptMarkers: [],
        // `codex login` prints `Starting local login server on
        // http://localhost:<port>` before the authorization URL (0.157.1).
        loginUrlPattern: /^https:\/\/auth\.openai\.com\//,
        // Read out of the 0.157.1 binary's own messages for a lapsed or missing
        // login; each names signing in again as the cure.
        expiredMarkers: [
          'refresh token has expired',
          'sign in again',
          'codex login',
          'no codex credentials were found',
        ],
        rateLimitPatterns: [/hit your usage limit/i],
        resetsAtPatterns: [/try again at ([^.\n]+)/i],
        isolatedEnvKeys: [
          ...CODEX_CREDENTIAL_ENV_KEYS,
          ...CODEX_ACCOUNT_ENV_KEYS,
        ],
        inheritedEnvKeys: [...CODEX_CREDENTIAL_ENV_KEYS],
      },
      sessions: {
        listingUnavailableReason: null,
        listingPartialReason: null,
        historyUnavailableReason: null,
        contentSearchUnavailableReason:
          'codex conversations are matched by title and folder — its own search reads at most the opening message, never what was said after it (measured on 0.157.1).',
      },
      configDir: {
        envVar: CODEX_HOME_ENV,
        unavailableReason: null,
        sessionCarryUnavailableReason:
          'codex keeps each conversation inside its own home directory, and moving one to another has not been measured',
      },
      followUp: {
        unavailableReason: null,
        // `turn/steer` adds to the running turn; codex answers it before the
        // turn completes.
        interrupts: false,
        consumptionReported: false,
      },
      usage: {
        // Every turn reports its tokens; its MONEY is not on the wire (only an
        // Enterprise workspace sees codex's own dollar estimate), so a turn is
        // priced from those tokens at list price — `listPrice` below.
        unavailableReason: null,
        breakdown: {
          kind: 'unavailable',
          reason:
            'codex reports how full the window is, not what fills it — the size is shown, the breakdown cannot be',
        },
        planLimits: { kind: 'reads', channel: 'live-process' },
        polledSpend: false,
        // codex's model ids are OpenAI's API ids (`gpt-6-astra`, `gpt-5.6-sol`
        // — measured against `~/.codex/models_cache.json` on 0.157.1), so the
        // public catalog's `openai` entries price them as they stand. A
        // ChatGPT plan is not billed per token, so on one this is what the
        // turn WOULD have cost at API list price; per model, never per
        // profile, so a Plus and an Enterprise profile price the same turn the
        // same. An id the catalog does not list (`codex-auto-review`) is
        // unpriced.
        listPrice: { kind: 'catalog', provider: 'openai' },
      },
      handoff: {
        kind: 'resume-command',
        resumeFlag: 'resume',
        /**
         * codex lets ONE process hold a thread (measured on 0.157.1): while
         * geniro's kept app-server has it — hours after every turn — a
         * terminal's `codex resume` says "This thread is open elsewhere", and
         * only the holder ending releases it. `codex fork` opens a new thread
         * carrying the whole history even as the holder runs, so a held
         * conversation is handed over as that copy.
         */
        heldFlag: 'fork',
        modelFlag: '-m',
        sessionIdPattern: CODEX_THREAD_ID_PATTERN,
      },
    };
  }

  /** One `model/list` answer per (profile, version), shared by both listings. */
  private readonly modelsCache = new ModelVocabularyCache<CodexModelEntry[]>({
    ttlMs: CODEX_MODELS_TTL_MS,
    now: Date.now,
  });

  constructor(private readonly codexOptions: CodexAdapterOptions = {}) {
    super(codexOptions);
  }

  /** This adapter as the daemon builds it. */
  static forDaemon(deps: AdapterDaemonDeps): CodexAdapter {
    return new CodexAdapter({
      spawn: deps.spawn,
      versions: deps.versions,
      processes: deps.processes,
      logger: deps.logger(CodexAdapter.name),
      clientVersion: deps.clientVersion,
      probeRootDir: join(deps.userDataDir, 'codex-probe'),
      prices: deps.prices,
    });
  }

  // ── The turn ──────────────────────────────────────────────────────────────

  /**
   * Everything per turn rides the protocol (cwd, model, policy, prompt), which
   * also keeps geniro's call token off `ps`. The auto-compaction threshold is
   * the one spawn-time setting — it belongs to the process.
   */
  protected buildArgs(input: AgentTurnInput): string[] {
    return [...CODEX_APP_SERVER_ARGS, ...this.autoCompactArgs(input)];
  }

  /** The protocol is a dialogue: stdin stays open for the whole turn. */
  protected override keepStdinOpen(_input: AgentTurnInput): boolean {
    return true;
  }

  /** One process for the whole conversation — codex threads outlive turns. */
  protected override canHostSession(_input: AgentTurnInput): boolean {
    return true;
  }

  /** The driver writes the handshake itself; there is no one-shot payload. */
  protected override buildStdinPayload(
    _input: AgentTurnInput,
  ): string | undefined {
    return undefined;
  }

  /**
   * The user's own exported codex credential (none by default — codex signs
   * in from `~/.codex`), and the run's config directory as `CODEX_HOME`.
   */
  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    return {
      ...this.inheritedEnv(),
      ...this.configDirEnv(input.configDir),
      ...input.env,
    };
  }

  protected mapMessage(): never {
    throw new Error(
      'CodexAdapter drives codex app-server through its per-turn driver, not mapMessage',
    );
  }

  protected override createTurnDriver(input: AgentTurnInput): TurnDriver {
    return new CodexSession(
      {
        clientVersion: this.clientVersion,
        turnOptions: (turnInput) => this.codexTurnOptions(turnInput),
        logger: this.codexOptions.logger,
        listPriceOf: (model) => this.listPriceOf(model),
      },
      input,
    );
  }

  /**
   * Everything about ONE turn, from THAT turn's input — never captured, so a
   * later message on a kept process cannot inherit an earlier one's posture.
   */
  private codexTurnOptions(input: AgentTurnInput): CodexTurnOptions {
    const endpoint = input.mcpEndpoint ?? null;
    return {
      input,
      developerInstructions: this.composeSystemPrompt(input, endpoint !== null),
      config:
        endpoint === null
          ? null
          : {
              [codexMcpServerKey(endpoint.serverName)]: {
                url: endpoint.url,
                http_headers: { Authorization: `Bearer ${endpoint.token}` },
                tool_timeout_sec: CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC,
              },
            },
      policy: codexTurnPolicy(input.approvalMode),
    };
  }

  /** The caller's projection of a parked `request_user_input`, off its card. */
  override questionFrom(input: unknown): AdapterQuestion | null {
    return adapterQuestionOf(codexCardQuestions(input));
  }

  /** Carry the card's free text to the reply encoder. */
  override withAnswer(input: unknown, answer: string): unknown {
    return withCodexAnswer(input, answer);
  }

  // ── One-shot questions to a fresh app-server ──────────────────────────────

  /**
   * Ask a fresh `codex app-server` one question and read its answer: the
   * handshake and the request go in together, and the process is ended the
   * moment the reply is out. Null when codex could not be asked or refused.
   */
  private async oneshot(
    method: string,
    params: unknown,
    options: AgentCommandOptions,
  ): Promise<unknown> {
    const reply = await this.oneshotReply(method, params, options);
    return reply?.ok === true ? reply.result : null;
  }

  /**
   * The same ask, answering codex's whole reply — for a caller that must tell
   * a refusal, and codex's own reason for it, from no answer at all.
   */
  private async oneshotReply(
    method: string,
    params: unknown,
    options: AgentCommandOptions,
  ): Promise<ReturnType<typeof codexOneshotReply>> {
    const stdout = await this.runCommand([...CODEX_APP_SERVER_ARGS], {
      ...options,
      stdinWrites: codexOneshotFrames(this.clientVersion, method, params),
      settleWhen: codexOneshotSettled,
      env: { ...options.env, ...this.configDirEnv(options.configDir) },
      timeoutMs: options.timeoutMs ?? CODEX_ONESHOT_TIMEOUT_MS,
    });
    return codexOneshotReply(stdout);
  }

  /**
   * A name for a chat, from a throwaway `codex exec` turn — codex names no
   * conversation it serves over app-server (none of a live thread's frames
   * carried a name on 0.157.1), so it is asked, once, the way claude is.
   */
  override async generateTitle(
    input: AgentTitleInput,
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('title');
      const stdout = await this.runCommand(
        [...CODEX_TITLE_ARGS, titlePrompt(input)],
        {
          ...options,
          cwd,
          // A turn loads the user's MCP servers, so the deadline reaps a group.
          processGroup: true,
          // `codex exec` reads stdin to EOF even with its prompt in argv.
          endStdin: true,
          env: { ...options.env, ...this.configDirEnv(input.configDir) },
          timeoutMs: options.timeoutMs ?? CODEX_TITLE_TIMEOUT_MS,
        },
      );
      return stdout === null ? null : readTitleAnswer(stdout);
    } catch {
      return null;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  /** `model/list` for one profile, cached per `--version`. */
  private async readModels(
    configDir: string | null,
    options: AgentCommandOptions,
  ): Promise<CodexModelEntry[]> {
    const version = await this.resolveBinaryVersion(options);
    return this.modelsCache.read(
      AgentKind.Codex,
      null,
      configDir,
      version,
      async () => {
        const result = await this.oneshot(
          CODEX_METHODS.modelList,
          {},
          { ...options, configDir },
        );
        const models = result === null ? [] : readCodexModels(result);
        // An empty answer is a failure to ask, not "this account has no
        // models" — never cached, so the next listing asks again.
        return models.length === 0 ? volatile(models) : models;
      },
    );
  }

  override async listModels(
    input: AgentModelsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentModel[]> {
    const models = await this.readModels(input.configDir, options);
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      source: 'cli',
    }));
  }

  /** The efforts ONE model accepts — each model states its own in `model/list`. */
  override async listModelEfforts(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentEffortListing> {
    const superset = await super.listModelEfforts(model, options);
    if (model === null) {
      return superset;
    }
    const entry = (
      await this.readModels(options.configDir ?? null, options)
    ).find((candidate) => candidate.id === model);
    return entry === undefined || entry.efforts.length === 0
      ? superset
      : { efforts: entry.efforts, unavailableReason: null, exact: true };
  }

  override clearCaches(): number {
    return this.modelsCache.clear();
  }

  /**
   * The same memory, on an ACCOUNT change: a `model/list` still running was
   * spawned under the credentials the user just replaced, so it is detached and
   * its reply is not filed (`ModelVocabularyCache.forget`) — {@link
   * clearCaches} alone would let it land afterwards and serve the previous
   * account's models for the rest of the TTL.
   */
  override forgetAccountCaches(): number {
    return this.modelsCache.forget(this.getConfig().kind);
  }

  /**
   * codex's skills, from its own `skills/list` — the ones only the binary
   * knows (plugin skills included), read in a throwaway folder so no project
   * layer leaks in; the disk scan covers the project's own.
   */
  override async listReportedCommands(
    options: AgentCommandOptions = {},
  ): Promise<AgentReportedCommand[]> {
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('skills');
      const result = await this.oneshot(
        CODEX_METHODS.skillsList,
        { cwds: [cwd] },
        { ...options, cwd },
      );
      const commands: AgentReportedCommand[] = [];
      for (const group of asArray(asRecord(result)?.data)) {
        for (const skill of asArray(asRecord(group)?.skills)) {
          const record = asRecord(skill);
          const name = record ? asString(record.name) : null;
          if (record && name && record.enabled !== false) {
            commands.push({ name, description: asString(record.description) });
          }
        }
      }
      return commands;
    } catch {
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  // ── MCP ───────────────────────────────────────────────────────────────────

  /**
   * codex's configured servers, from `codex mcp list --json`. A switched-off
   * server carries `disabled` on its own row, which is all the toggle needs —
   * so this CLI reads no folder facts of its own.
   */
  override async listMcpServers(
    input: AgentMcpServersInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    const stdout = await this.runCommand([...CODEX_MCP_LIST_ARGS], {
      ...options,
      cwd: input.cwd,
      env: { ...options.env, ...this.configDirEnv(input.configDir) },
    });
    const servers = stdout === null ? null : parseCodexMcpList(stdout);
    return servers === null
      ? { ok: false, reason: 'codex could not list its MCP servers' }
      : { ok: true, servers };
  }

  /**
   * Switch one server on or off in codex's own config — through codex itself
   * (`config/value/write`), so it owns the write to its `config.toml`. The
   * setting is codex's per-profile one and so covers every folder.
   */
  override async setMcpServerEnabled(
    _cwd: string,
    server: string,
    enabled: boolean,
    options: AgentCommandOptions = {},
  ): Promise<void> {
    if (CODEX_UNSAFE_SERVER_NAME.test(server)) {
      throw new Error(
        `codex cannot address the MCP server "${server}" by name — its config key would be ambiguous`,
      );
    }
    const reply = await this.oneshotReply(
      CODEX_METHODS.configValueWrite,
      {
        keyPath: codexMcpServerKey(server, CODEX_MCP_ENABLED_FIELD),
        value: enabled,
        mergeStrategy: 'upsert',
      },
      options,
    );
    if (reply === null) {
      throw new Error(
        'codex did not answer the request to change its MCP servers',
      );
    }
    if (!reply.ok) {
      throw new Error(
        `codex refused to change its MCP servers: ${reply.message}`,
      );
    }
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  override async listSessions(
    input: AgentSessionsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentSessionListing> {
    const searching = (input.query ?? '').trim() !== '';
    const page = searching
      ? Math.max(input.limit, CODEX_SESSION_SEARCH_PAGE)
      : input.limit;
    let result: unknown;
    try {
      result = await this.oneshot(
        CODEX_METHODS.threadList,
        { limit: page, ...(input.cwd ? { cwd: input.cwd } : {}) },
        { ...options, configDir: input.configDir },
      );
    } catch {
      result = null;
    }
    if (result === null) {
      return {
        sessions: [],
        unavailableReason: 'codex could not be asked for its conversations',
        partialReason: null,
      };
    }
    const all = readCodexThreads(result);
    const matched = matchSessions(all, input.query);
    const hasMore = asString(asRecord(result)?.nextCursor) !== null;
    return {
      sessions: matched.slice(0, input.limit),
      unavailableReason: null,
      partialReason:
        hasMore || matched.length > input.limit
          ? `only the ${page} most recent conversations were read`
          : null,
    };
  }

  /** codex resumes a thread by id from its own home — nothing to bring across. */
  override prepareSessionImport(
    _input: AgentSessionImportInput,
  ): Promise<void> {
    return Promise.resolve();
  }

  override async readSessionHistory(
    input: AgentSessionImportInput & { limit: number },
  ): Promise<AgentSessionHistory | null> {
    try {
      const result = await this.oneshot(
        CODEX_METHODS.threadRead,
        { threadId: input.sessionId, includeTurns: true },
        { cwd: input.cwd, configDir: input.configDir },
      );
      return result === null ? null : codexThreadHistory(result, input.limit);
    } catch {
      return null;
    }
  }

  /**
   * Delete one thread through codex's own `thread/delete` — probed on 0.157.1:
   * it answers `{}`, announces `thread/deleted`, and the rollout file under
   * `<CODEX_HOME>/sessions` is gone; a thread already gone answers
   * `-32600 no rollout found`. codex owns its store, so geniro never touches
   * its files.
   *
   * Asked `thread/read` first, for the one fact the delete must not proceed
   * without: when the thread began. A thread older than the run was imported
   * from the user's own codex and is kept. `createdAt` is whole SECONDS, so a
   * thread started within the run's first second reads as up to a second
   * early — the comparison allows that second, and nothing an import can
   * produce is that close, since a picker has to be opened and a row chosen.
   */
  override async deleteSessionTranscript(
    input: DeleteSessionTranscriptInput,
  ): Promise<DeleteSessionTranscriptResult> {
    const options = { configDir: input.configDir };
    let thread: Readonly<Record<string, unknown>> | null;
    try {
      thread = asRecord(
        asRecord(
          await this.oneshot(
            CODEX_METHODS.threadRead,
            { threadId: input.sessionId, includeTurns: false },
            options,
          ),
        )?.thread,
      );
    } catch {
      thread = null;
    }
    const createdAt = thread ? asNumber(thread.createdAt) : null;
    if (createdAt === null) {
      return {
        deleted: false,
        reason: 'codex did not say when the thread began, so it was kept',
      };
    }
    if (createdAt * 1000 + 1000 <= input.runCreatedAt.getTime()) {
      return {
        deleted: false,
        reason:
          'the thread began before this chat — it was imported from codex, so it was kept',
      };
    }
    let reply: ReturnType<typeof codexOneshotReply>;
    try {
      reply = await this.oneshotReply(
        CODEX_METHODS.threadDelete,
        { threadId: input.sessionId },
        options,
      );
    } catch {
      reply = null;
    }
    if (reply === null) {
      return { deleted: false, reason: 'codex did not answer the delete' };
    }
    return reply.ok
      ? { deleted: true }
      : { deleted: false, reason: `codex refused: ${reply.message}` };
  }

  /**
   * The account's plan limits, asked of the RUNNING process — which runs under
   * the run's own `CODEX_HOME`, so the answer is that account's rather than
   * whichever one a fresh process would find.
   */
  override readPlanLimits(
    input: AgentSessionReadInput,
  ): Promise<AgentPlanLimits | null> {
    if (!input.live) {
      return Promise.resolve(null);
    }
    const requestId = `geniro-limits-${randomUUID()}`;
    return input.live.ask({
      line: codexPlanLimitsRequestLine(requestId),
      read: (obj) => readCodexPlanLimitsReply(obj, requestId),
      timeoutMs: CODEX_PLAN_LIMITS_TIMEOUT_MS,
    });
  }
}
