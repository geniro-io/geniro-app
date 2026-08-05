import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentKind } from '../../../runs/runs.types';
import { claudeCredentialEnv } from '../../utils/child-env';
import type {
  AdapterConfig,
  AdapterQuestion,
  AgentApprovalMode,
  AgentCommandOptions,
  AgentEvent,
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpServersInput,
  AgentModel,
  AgentTurnInput,
  InstalledApprovalSupport,
  InstalledCapabilities,
} from '../adapter.types';
import { GENIRO_MCP_SERVER_KEY } from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';
import {
  CLAUDE_APPEND_SYSTEM_PROMPT_FLAG,
  CLAUDE_BASE_ARGS,
  CLAUDE_DENY_MESSAGE,
  CLAUDE_EFFORT_FLAG,
  CLAUDE_HOME_SETTINGS_FILE,
  CLAUDE_MCP_CONFIG_DIR_NAME,
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_MCP_EMPTY_MARKER,
  CLAUDE_MCP_LIST_ARGS,
  CLAUDE_MCP_LIST_FAILED_MESSAGE,
  CLAUDE_MCP_LIST_TIMEOUT_MS,
  CLAUDE_MCP_LIST_UNREADABLE_MESSAGE,
  CLAUDE_MCP_TOOL_TIMEOUT_ENV,
  CLAUDE_MCP_TOOL_TIMEOUT_MS,
  CLAUDE_MODEL_CACHE_FILE,
  CLAUDE_MODEL_FLAG,
  CLAUDE_PARTIAL_MESSAGES_FLAG,
  CLAUDE_PERMISSION_MODE_DEFAULT,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
  CLAUDE_PLUGIN_DIR_FLAG,
  CLAUDE_PROJECT_MCP_FILE,
  CLAUDE_PROJECT_SETTINGS_FILES,
  CLAUDE_RESUME_FLAG,
  CLAUDE_SETTINGS_FLAG,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
} from './claude.const';
import type { ClaudeAdapterOptions } from './claude.types';
import { buildImageBlocks } from './utils/claude-images.utils';
import {
  definesGeniroServer,
  sweepStaleTurnMcpConfigs,
  sweepStaleTurnSettings,
  writeTurnMcpConfig,
  writeTurnSettings,
} from './utils/claude-mcp-config.utils';
import {
  parseDisabledServerNames,
  parseHomeDisabledServerNames,
  parseProjectServerNames,
} from './utils/claude-mcp-folder.utils';
import { parseMcpList } from './utils/claude-mcp-list.utils';
import { mapClaudeMessage } from './utils/claude-message.utils';
import { claudeModels } from './utils/claude-models.utils';
import {
  optionLabelsOf,
  questionTextOf,
  withResponse,
} from './utils/claude-question.utils';

/**
 * Drives `claude` headlessly. The prompt is sent as a stream-json user-message
 * line on stdin (`--input-format stream-json`); `--verbose` is required for
 * stream-json output. Resume passes the prior `session_id` via `--resume`.
 *
 * Graph-node extras: `systemPrompt` rides `--append-system-prompt`;
 * `approvalMode: 'ask'` switches on the stdin control protocol
 * (`--permission-prompt-tool stdio` — the CLI pauses each permission-gated
 * tool call as a `control_request` and resumes on our `control_response`),
 * while `'auto'` bypasses permission checks for unattended team execution.
 * Plain chat (no `approvalMode`) keeps the M2 argv byte-for-byte.
 */
export class ClaudeAdapter extends AgentAdapter {
  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.Claude,
      /**
       * Probe-verified: a plain chat turn under `--permission-mode default
       * --permission-prompt-tool stdio` offers this tool, and its request
       * arrives as `can_use_tool` with `requires_user_interaction: true`.
       */
      questionToolName: 'AskUserQuestion',
      approval: {
        /** Every `--permission-mode` value the CLI exposes, plus the `auto` bypass. */
        modes: ['auto', 'ask', 'acceptEdits', 'plan'],
        /**
         * The two modes headless claude has been seen to reject on some builds
         * — so a run requesting either waits out the mode probe, and a run that
         * never does pays nothing.
         */
        probedModes: ['acceptEdits', 'plan'],
        /**
         * `acceptEdits` degrades to `ask` on a probed FAIL — the turn still
         * runs, every edit just asks first.
         *
         * `plan` is deliberately ABSENT, even though it is probed the same
         * way: turning a no-execute mode into an executing `ask` would invert
         * the whole promise the user selected it for. An unsupported `plan`
         * rides through and the CLI rejects it loudly, which is the honest
         * failure. Do not add it here "for completeness".
         *
         * An UNPROBED mode keeps what was asked for, so a real rejection
         * surfaces from the CLI rather than from a guess made here.
         */
        degradeOnProbeFail: {
          acceptEdits: {
            to: 'ask',
            /** `acceptEdits` still runs on a probed FAIL — every edit just asks first. */
            reason:
              "installed claude does not support acceptEdits — this turn runs as 'ask'",
          },
        },
        /** Four honoured modes — the sole-mode collapse never applies to claude. */
        soleModeDegradeReason: null,
      },
      /**
       * The values `claude --effort` accepts, weakest first.
       *
       * WRITTEN DOWN RATHER THAN SCRAPED, because the CLI under-reports itself.
       * Its own `--help` says "Valid values: low, medium, high, xhigh, max" and
       * its warning line repeats that set — but `ultracode` is accepted just as
       * silently as the five it names.
       *
       * Probe-verified on claude 2.1.220 (2026-07-29) by feeding each candidate
       * and testing for the `Unknown --effort value` warning:
       * - accepted, no warning: low, medium, high, xhigh, max, `ultracode`
       * - rejected with the warning: `ultrathink`, and the control
       *   `zzz-not-a-level`
       *
       * So a `--help` scrape would drop `ultracode` (a level the user asked for
       * by name), and guessing would never have found it. Re-probe the same way
       * when this list is revised; do not copy it out of help output.
       */
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'xhigh' },
        { id: 'max', label: 'max' },
        { id: 'ultracode', label: 'ultracode' },
      ],
      /**
       * The aliases `claude --model` documents: each resolves to the latest
       * model of its tier, so they stay correct across releases without an app
       * update. This is the floor of the list, never the whole of it.
       */
      builtinModels: [
        { id: 'opus', label: 'opus', source: 'builtin' },
        { id: 'sonnet', label: 'sonnet', source: 'builtin' },
        { id: 'haiku', label: 'haiku', source: 'builtin' },
      ],
      skillRoots: {
        /** `<root>/.claude/skills/<name>/SKILL.md`. */
        skills: [['.claude', 'skills']],
        /** `<root>/.claude/commands/**.md`. */
        commands: [['.claude', 'commands']],
      },
      liveStream: {
        /** Utility argv whose stdout is searched for {@link CLAUDE_PARTIAL_MESSAGES_FLAG}. */
        probeArgs: ['--help'],
        flag: CLAUDE_PARTIAL_MESSAGES_FLAG,
      },
      reportedCommands: {
        /** Never reached by the model: the turn is cancelled the moment init lands. */
        probePrompt: 'Reply with exactly: ok',
        /** A hung probe must not wedge the caller forever. */
        probeTimeoutMs: 30_000,
        /** Defensive bound — init reports ~60 entries today. */
        maxCommands: 500,
        /**
         * `_`-prefixed names are claude's INTERNAL commands
         * (`__remote-workflow`) — reported, but not things a user invokes.
         * SkillHarvestStore drops them from the other report path too.
         */
        internalPrefix: '_',
      },
      mcp: {
        /**
         * The endpoint is handed to claude per turn, so nothing about the
         * machine has to be trusted in advance.
         */
        callToolsRequireTrustProbe: false,
        /** `--mcp-config` carries the endpoint for one turn; no cwd file is touched. */
        endpointRequiresCwdConfig: false,
        /**
         * Null: `claude mcp list` reports them, so this adapter overrides
         * `listMcpServers` and an empty answer really does mean an empty folder.
         */
        listingUnavailableReason: null,
        /** Project `.mcp.json` servers can be switched off; verified live. */
        toggleUnavailableReason: null,
        notInToggleableScopeReason:
          'only servers defined in this folder\u2019s .mcp.json can be switched off',
        userDisabledReason:
          'switched off in your own claude settings, which geniro cannot re-enable',
      },
      plugin: {
        /** `--plugin-dir` — repeatable, session-only (verified on 2.1.220). */
        unavailableReason: null,
      },
      terminal: {
        resumeFlag: CLAUDE_RESUME_FLAG,
        modelFlag: CLAUDE_MODEL_FLAG,
        /**
         * What a resumable claude session id looks like. A missing or
         * foreign-shaped id is not a mirror target — opening the TUI without
         * one would start an unrelated fresh conversation instead of showing
         * the run's own.
         */
        sessionIdPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
      },
    };
  }

  /**
   * Claude's own slice of the capability bag: the permission-mode probe's
   * verdict, translated into the adapter-agnostic tri-state.
   *
   * The ONE thing config cannot express, and the whole reason this override
   * survives: `config.approval.probedModes` declares WHICH modes are probed,
   * but only this adapter knows the verdict arrives under the bag's
   * CLI-NAMED `claudeModes` field. There is exactly one approval probe in the
   * daemon and it is claude's, so the bag is handed to whichever adapter runs
   * a turn and each takes only its own slice — an adapter that declared no
   * probed mode keeps the base's empty answer.
   *
   * `unknown` maps to ABSENT, never to `false`. The distinction is the whole
   * point: an unprobed mode keeps what the caller asked for, so a genuine
   * rejection surfaces loudly from the CLI itself instead of being pre-empted
   * by a degrade nobody proved was needed.
   */
  override approvalSupportFrom(
    capabilities: InstalledCapabilities,
  ): InstalledApprovalSupport {
    const { claudeModes } = capabilities;
    const supported: Partial<Record<AgentApprovalMode, boolean>> = {};
    if (claudeModes.acceptEdits !== 'unknown') {
      supported.acceptEdits = claudeModes.acceptEdits === 'pass';
    }
    if (claudeModes.plan !== 'unknown') {
      supported.plan = claudeModes.plan === 'pass';
    }
    return { supported };
  }

  /**
   * claude's question channel is the AskUserQuestion tool
   * (`config.questionToolName`), whose input carries the questions, their
   * headers and their option labels. Projecting it is the adapter's job, so
   * the graph executor can bridge a callee's question to its caller without
   * ever holding claude's payload shape.
   *
   * Never null: a request that reached here IS the question tool's, and a
   * malformed or version-drifted payload degrades to empty projections rather
   * than claiming there was no question (see `utils/claude-question.utils`).
   */
  override questionFrom(input: unknown): AdapterQuestion {
    return { text: questionTextOf(input), options: optionLabelsOf(input) };
  }

  /**
   * The answer rides back as AskUserQuestion's `response` field — the
   * probe-verified free-text channel claude surfaces to the model.
   */
  override withAnswer(input: unknown, answer: string): unknown {
    return withResponse(input, answer);
  }

  /** Per-turn `--mcp-config` file paths, written by prepareTurn. */
  private readonly mcpConfigPaths = new WeakMap<AgentTurnInput, string>();
  private readonly settingsPaths = new WeakMap<AgentTurnInput, string>();

  constructor(private readonly claudeOptions: ClaudeAdapterOptions = {}) {
    super(claudeOptions);
  }

  /**
   * Drop the per-turn config files a prior daemon launch left behind. Called
   * once at boot; a no-op when the daemon named no config dir, since the OS
   * tmpdir fallback is only ever used standalone.
   */
  sweepStaleConfigs(): void {
    const dir = this.claudeOptions.mcpConfigDir;
    if (dir) {
      sweepStaleTurnMcpConfigs(dir);
      sweepStaleTurnSettings(dir);
    }
  }

  /**
   * Materialize the two per-turn files this CLI reads from disk, and hand back
   * one disposer for whichever were written.
   *
   * A caller turn's MCP config is a 0600 file because the call token must never
   * ride argv (visible in `ps`), so argv carries only the path. The settings
   * file is per-turn for a different reason: the disabled set is read when the
   * turn is built, so writing it here means argv can never point at a file a
   * toggle in another window has since rewritten.
   */
  protected override prepareTurn(
    input: AgentTurnInput,
  ): (() => void) | undefined {
    const dir =
      this.claudeOptions.mcpConfigDir ??
      join(tmpdir(), CLAUDE_MCP_CONFIG_DIR_NAME);
    const written: string[] = [];
    const discard = (): void => {
      this.mcpConfigPaths.delete(input);
      this.settingsPaths.delete(input);
      for (const path of written) {
        rmSync(path, { force: true });
      }
    };
    try {
      if (input.mcpEndpoint) {
        // Refused BEFORE anything is written, so a rejected turn leaves no file
        // behind. `--strict-mcp-config` is no longer passed, so the user's own
        // servers load alongside the call surface: an entry under geniro's key
        // would be silently dropped in favour of ours (probe-verified — ours
        // wins), leaving the user's server missing with no word said.
        const collision = definesGeniroServer(
          input.cwd,
          this.claudeOptions.homeDir,
        );
        if (collision !== null) {
          throw new Error(
            `${collision} defines a server named "${GENIRO_MCP_SERVER_KEY}", which is the name this run uses for its own agent-to-agent call surface. Rename it to run this node.`,
          );
        }
        const path = writeTurnMcpConfig(dir, input.mcpEndpoint);
        this.mcpConfigPaths.set(input, path);
        written.push(path);
      }
      const settingsPath = writeTurnSettings(
        dir,
        input.disabledMcpServers ?? [],
      );
      if (settingsPath !== null) {
        this.settingsPaths.set(input, settingsPath);
        written.push(settingsPath);
      }
    } catch (err) {
      // A throw from the SECOND write would otherwise strand the first file —
      // and the first one carries the run's call token at mode 0600, with no
      // disposer yet in existence to remove it.
      discard();
      throw err;
    }
    return written.length === 0 ? undefined : discard;
  }

  /**
   * claude has no list-models subcommand to run, so nothing is spawned: the
   * list is the documented tier aliases plus the account-specific models the
   * CLI caches in `~/.claude.json` for its own picker. Synchronous work behind
   * an async signature — the contract is shared with cursor, which really does
   * shell out.
   *
   * The alias floor comes from `config.builtinModels` — the declared fallback
   * surface — never from the const behind it, so config stays the one place a
   * CLI's static values are read.
   */
  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve(
      claudeModels(this.getConfig().builtinModels, this.claudeOptions.homeDir),
    );
  }

  /**
   * claude DOES have a listing subcommand, so this shells out — and it is the
   * one utility command that needs `processGroup`
   * ({@link AgentCommandOptions.processGroup} says why).
   *
   * A null stdout is the command having FAILED — missing binary, non-zero
   * exit, or the deadline — and is reported as such rather than as an empty
   * listing. The distinction is load-bearing downstream: an empty listing is
   * cached and shown as "no servers", which would be a lie about the user's
   * configuration for as long as the entry lives.
   *
   * Output is prose (the CLI rejects `--json`), so the parse is deliberately
   * forgiving and lives in its own pure function.
   */
  override async listMcpServers(
    input: AgentMcpServersInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    // PREPENDED, not appended: `--plugin-dir` is a global option, and
    // `claude mcp list --plugin-dir X` is rejected outright as an unknown
    // option (probe-verified on 2.1.220). Before the subcommand is the only
    // placement the CLI accepts here.
    const pluginArgs = input.pluginDir
      ? [CLAUDE_PLUGIN_DIR_FLAG, input.pluginDir]
      : [];
    const stdout = await this.runCommand(
      [...pluginArgs, ...CLAUDE_MCP_LIST_ARGS],
      {
        ...options,
        cwd: input.cwd,
        processGroup: true,
        timeoutMs: options.timeoutMs ?? CLAUDE_MCP_LIST_TIMEOUT_MS,
      },
    );
    if (stdout === null) {
      return { ok: false, reason: CLAUDE_MCP_LIST_FAILED_MESSAGE };
    }
    const servers = parseMcpList(stdout);
    if (servers.length === 0 && !stdout.includes(CLAUDE_MCP_EMPTY_MARKER)) {
      // The CLI answered, but nothing in what it said looked like a row and it
      // did not say the folder was empty either. Reporting that as an empty
      // listing would let it be cached and shown as "no servers" — the
      // confident lie the whole ok/err split exists to prevent, and the one a
      // reworded row format would otherwise produce silently.
      return { ok: false, reason: CLAUDE_MCP_LIST_UNREADABLE_MESSAGE };
    }
    return { ok: true, servers };
  }

  /**
   * What claude's own files say about a folder, which is what decides whether
   * a row may carry a switch at all. Both reads are best-effort and neither
   * writes anything — see `utils/claude-mcp-folder.utils.ts` for the probe
   * evidence behind the two questions.
   */
  override async readMcpFolderFacts(cwd: string): Promise<AgentMcpFolderFacts> {
    const read = async (path: string): Promise<string | null> => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        // Absent, unreadable, or a directory — all mean "this file says
        // nothing", never a failure the user should see.
        return null;
      }
    };
    const home = this.claudeOptions.homeDir ?? homedir();
    const projectSource = await read(join(cwd, CLAUDE_PROJECT_MCP_FILE));
    const settingsSources = await Promise.all([
      ...CLAUDE_PROJECT_SETTINGS_FILES.map((rel) => read(join(cwd, rel))),
      read(join(home, CLAUDE_HOME_SETTINGS_FILE)),
    ]);
    // Where answering "No" to the CLI's own trust prompt lands — a different
    // file and a different shape from the settings ones, but the same
    // question, and the ordinary way a user switches a project server off.
    const homeConfig = await read(join(home, CLAUDE_MODEL_CACHE_FILE));
    // Union, because that is how the CLI itself combines them: a name in ANY
    // of these is one geniro cannot pull back out.
    const userDisabled = new Set<string>();
    for (const source of settingsSources) {
      if (source !== null) {
        for (const name of parseDisabledServerNames(source)) {
          userDisabled.add(name);
        }
      }
    }
    if (homeConfig !== null) {
      for (const name of parseHomeDisabledServerNames(homeConfig, cwd)) {
        userDisabled.add(name);
      }
    }
    return {
      projectServers:
        projectSource === null ? [] : parseProjectServerNames(projectSource),
      userDisabled: [...userDisabled],
    };
  }

  protected buildArgs(input: AgentTurnInput): string[] {
    const args = [...CLAUDE_BASE_ARGS];
    if (input.streamPartials) {
      args.push(CLAUDE_PARTIAL_MESSAGES_FLAG);
    }
    if (input.model) {
      args.push(CLAUDE_MODEL_FLAG, input.model);
    }
    if (input.effort) {
      // An unknown value here is not fatal — the CLI warns and runs on its own
      // default — but the caller has already refused anything outside
      // `listEfforts()`, so the flag only carries a level claude accepts.
      args.push(CLAUDE_EFFORT_FLAG, input.effort);
    }
    if (input.resumeSessionId) {
      args.push(CLAUDE_RESUME_FLAG, input.resumeSessionId);
    }
    if (input.pluginDir) {
      // Session-scoped: the plugin is loaded for this invocation only, so two
      // nodes of one graph can run with different tools without either
      // installing anything. The caller has already refused an unusable path
      // — the CLI would ignore one silently.
      args.push(CLAUDE_PLUGIN_DIR_FLAG, input.pluginDir);
    }
    // Claude's endpoint is a per-turn config file `prepareTurn` writes from
    // this same field, so having it IS the grant.
    const systemPrompt = this.composeSystemPrompt(
      input,
      Boolean(input.mcpEndpoint),
    );
    if (systemPrompt) {
      args.push(CLAUDE_APPEND_SYSTEM_PROMPT_FLAG, systemPrompt);
    }
    if (input.approvalMode === 'auto' && input.allowUserQuestions) {
      // `--dangerously-skip-permissions` STRIPS AskUserQuestion, so an auto
      // turn that must be able to ask spawns on the stdio dialogue instead
      // (`default` is the CLI's name for ask). Unattended semantics are not
      // lost — the DAEMON becomes the bypass, auto-approving every plain
      // permission request at its approval seam and reserving the human card
      // for genuine questions.
      args.push(CLAUDE_PERMISSION_MODE_FLAG, CLAUDE_PERMISSION_MODE_DEFAULT);
      args.push(
        CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
        CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
      );
    } else if (input.approvalMode === 'auto') {
      args.push(CLAUDE_SKIP_PERMISSIONS_FLAG);
    } else if (input.approvalMode) {
      // ask/acceptEdits/plan all hold the stdio approval dialogue; `ask` is
      // the CLI's `default` permission mode, the other modes map by name.
      args.push(
        CLAUDE_PERMISSION_MODE_FLAG,
        input.approvalMode === 'ask'
          ? CLAUDE_PERMISSION_MODE_DEFAULT
          : input.approvalMode,
      );
      args.push(
        CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
        CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
      );
    }
    // OUTSIDE the caller-node branch below: the disabled set applies to every
    // turn, chat and graph node alike, not only to one that carries a call
    // surface.
    const settingsPath = this.settingsPaths.get(input);
    if (settingsPath) {
      args.push(CLAUDE_SETTINGS_FLAG, settingsPath);
    }
    const mcpConfigPath = this.mcpConfigPaths.get(input);
    if (mcpConfigPath) {
      // Deliberately WITHOUT `--strict-mcp-config`. An agent must see the same
      // MCP servers a fresh claude session in that folder sees, PLUS geniro's
      // call surface — they combine. Restricting the turn to our config alone
      // would also make the MCP switch meaningless for a caller node, since
      // there would be no project servers loaded to switch off. The collision
      // guard in `prepareTurn` is what keeps the call surface unambiguous now
      // that the project's own servers load beside it.
      args.push(CLAUDE_MCP_CONFIG_FLAG, mcpConfigPath);
    }
    return args;
  }

  protected override buildEnv(
    input: AgentTurnInput,
  ): Record<string, string> | undefined {
    // buildChildEnv strips the daemon's inherited Anthropic credentials from
    // every child; re-inject them for THIS child only (a cursor agent and its
    // tool grandchildren never see them). An explicit input.env wins.
    const env = { ...claudeCredentialEnv(), ...input.env };
    if (!input.mcpEndpoint) {
      return env;
    }
    return {
      ...env,
      [CLAUDE_MCP_TOOL_TIMEOUT_ENV]: String(
        input.mcpEndpoint.toolTimeoutMs ?? CLAUDE_MCP_TOOL_TIMEOUT_MS,
      ),
    };
  }

  protected override buildStdinPayload(input: AgentTurnInput): string {
    return `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        // Attached images ride as real base64 content blocks — the CLI's
        // stream-json input accepts the Messages-API block shape, so the model
        // SEES the image directly (probe-verified on claude 2.1.220, in either
        // block order). Handing over a path instead would cost a Read
        // round-trip and put an image behind the permission gate.
        content: [
          ...buildImageBlocks(input.images),
          { type: 'text', text: input.prompt },
        ],
      },
    })}\n`;
  }

  protected override keepStdinOpen(input: AgentTurnInput): boolean {
    // Every stdio-dialogue mode (ask/acceptEdits/plan) can raise a mid-turn
    // control_request; only auto (and plain chat) closes stdin after the
    // prompt payload — UNLESS that auto turn was spawned on the dialogue to
    // keep its question channel, in which case the verdict has to have a way
    // back in (see buildArgs).
    if (input.approvalMode === undefined) {
      return false;
    }
    return input.approvalMode !== 'auto' || input.allowUserQuestions === true;
  }

  protected override buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string {
    return `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: allow
          ? { behavior: 'allow', updatedInput: updatedInput ?? {} }
          : { behavior: 'deny', message: CLAUDE_DENY_MESSAGE },
      },
    })}\n`;
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapClaudeMessage(obj);
  }
}
