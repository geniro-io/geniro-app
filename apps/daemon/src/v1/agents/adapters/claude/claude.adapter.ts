import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { lock } from 'proper-lockfile';

import { atomicWrite } from '../../../../utils/atomic-file';
import { AgentKind } from '../../../runs/runs.types';
import {
  CLAUDE_CREDENTIAL_KEYS,
  claudeCredentialEnv,
} from '../../utils/child-env';
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
  FollowUpMessage,
  InstalledApprovalSupport,
  InstalledCapabilities,
  TurnImage,
} from '../adapter.types';
import { GENIRO_MCP_SERVER_KEY } from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';
import {
  CLAUDE_APPEND_SYSTEM_PROMPT_FLAG,
  CLAUDE_AUTH_EXPIRED_MARKERS,
  CLAUDE_AUTH_LOGIN_ARGS,
  CLAUDE_BASE_ARGS,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CONFIG_LOCK_RETRIES,
  CLAUDE_CONFIG_LOCK_SUFFIX,
  CLAUDE_CONTROL_REQUEST_ID_PREFIX,
  CLAUDE_DENY_MESSAGE,
  CLAUDE_EFFORT_FLAG,
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_HOME_SETTINGS_FILE,
  CLAUDE_INTERRUPT_SUBTYPE,
  CLAUDE_MCP_CONFIG_DIR_NAME,
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_MCP_EMPTY_MARKER,
  CLAUDE_MCP_LIST_ARGS,
  CLAUDE_MCP_LIST_FAILED_MESSAGE,
  CLAUDE_MCP_LIST_TIMEOUT_MS,
  CLAUDE_MCP_LIST_UNREADABLE_MESSAGE,
  CLAUDE_MCP_LOGIN_ARGS,
  CLAUDE_MCP_TOOL_TIMEOUT_ENV,
  CLAUDE_MCP_TOOL_TIMEOUT_MS,
  CLAUDE_MODEL_CACHE_FILE,
  CLAUDE_MODEL_FLAG,
  CLAUDE_PARTIAL_MESSAGES_FLAG,
  CLAUDE_PERMISSION_MODE_DEFAULT,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
  CLAUDE_PROJECT_SETTINGS_FILES,
  CLAUDE_RESUME_FLAG,
  CLAUDE_SET_PERMISSION_MODE_SUBTYPE,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  CLAUDE_STRICT_MCP_CONFIG_FLAG,
  CLAUDE_UNSET_MODE_FALLBACK,
} from './claude.const';
import type { ClaudeAdapterOptions } from './claude.types';
import { buildImageBlocks } from './utils/claude-images.utils';
import {
  definesGeniroServer,
  sweepStaleTurnMcpConfigs,
  writeTurnMcpConfig,
} from './utils/claude-mcp-config.utils';
import {
  parseDisabledServerNames,
  parseHomeDisabledServerNames,
} from './utils/claude-mcp-folder.utils';
import { parseMcpList } from './utils/claude-mcp-list.utils';
import type { ClaudeHomeConfig } from './utils/claude-mcp-toggle.utils';
import {
  parseHomeConfig,
  readDisabledServers,
  withDisabledServer,
} from './utils/claude-mcp-toggle.utils';
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
      /**
       * True: the tool is wired only when the turn HAS a permission-prompt
       * channel. Re-probed on 2.1.227 by reading `system/init`'s own tool
       * list — with `--permission-prompt-tool stdio` it is present under every
       * mode, and without it absent under every mode — so an unattended turn
       * that must be able to ask has to be moved off the bypass.
       */
      questionsCostAskPosture: true,
      subagents: {
        /**
         * The Task tool's delegates ride the SAME stream-json stream as the
         * main thread, each line carrying `parent_tool_use_id` — read in
         * `utils/claude-message.utils.ts` and stamped onto the item payload by
         * `utils/event-to-item.ts`. It is the id of the launching tool call,
         * which is what lets the renderer nest a delegate's work under the row
         * that started it rather than beside the conversation.
         */
        reports: true,
        unavailableReason: null,
      },
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
        /**
         * Every scope can be switched off, through the CLI's own per-folder
         * `disabledMcpServers` list — probe-verified on 2.1.222, including the
         * `local` scope the old settings-file route could not reach.
         */
        toggleUnavailableReason: null,
        /**
         * Probe-verified on 2.1.226, and the reason it is a NOTE rather than
         * extra rows: the CLI's own `/mcp` panel carries a
         * "Built-in MCPs (always available)" group — `claude-in-chrome` and
         * `computer-use` — that a headless turn does not load at all. A
         * headless `system/init` advertises 210 tools, 177 of them `mcp__`,
         * and NONE matching either name; `claude mcp list` says "List
         * CONFIGURED MCP servers" and reports neither. There is no channel
         * that would let geniro list them honestly, and no reason to want one:
         * both are interactive-session integrations, so a row here would
         * promise the agent tools it will not have.
         */
        interactiveOnlyNote:
          'claude also loads claude-in-chrome and computer-use in its own interactive session. They are not loaded in the headless turns geniro runs, so they are not listed here.',
        userDisabledReason:
          'switched off in your own claude settings, which geniro cannot re-enable',
        /** `claude mcp login <name>` — probe-verified on 2.1.223. */
        loginArgs: CLAUDE_MCP_LOGIN_ARGS,
        loginUnavailableReason: null,
      },
      auth: {
        /** `claude auth login` — read from `claude auth --help` on 2.1.227. */
        loginArgs: CLAUDE_AUTH_LOGIN_ARGS,
        loginUnavailableReason: null,
        expiredMarkers: CLAUDE_AUTH_EXPIRED_MARKERS,
        /**
         * The Anthropic credentials `buildChildEnv` strips from every child, so
         * they never reach the cursor agent. Declaring them here re-injects them
         * for claude's own children — turns AND the `runCommand` listings.
         *
         * The listings are the part that was missing, and it was an assumption
         * rather than a measurement: this adapter's `buildEnv` re-injected them
         * on the turn path only, and the claim that its utility reads need
         * nothing rested on the local machine authenticating by OAuth, where
         * these variables are unset either way. For an account whose ONLY
         * credential is an exported `ANTHROPIC_API_KEY`, `claude mcp list` ran
         * with it stripped — the symmetric shape of the cursor bug this change
         * was written to fix. Same list as the strip, so neither can drift.
         */
        inheritedEnvKeys: CLAUDE_CREDENTIAL_KEYS,
      },
      configDir: {
        /**
         * `CLAUDE_CONFIG_DIR` — probe-verified on 2.1.227: a headless turn
         * pointed at an empty directory wrote its whole profile there and
         * reported "Not logged in", which is what makes a second directory a
         * second account.
         *
         * This var is ALSO named in `utils/child-env.ts`'s stripped set, so an
         * ambient one cannot select a profile for a run that named none; that
         * set has to be the union over every CLI, which is why the name appears
         * in both places. Keep them in step.
         */
        envVar: CLAUDE_CONFIG_DIR_ENV,
        unavailableReason: null,
      },
      followUp: {
        /**
         * A stream-json stdin is a CONVERSATION: a second `{"type":"user"}`
         * line on a still-open pipe is acted on at the next tool boundary
         * (probe-verified on 2.1.222). `buildFollowUpPayload` is the override
         * this null promises — the two are pinned together by spec.
         */
        unavailableReason: null,
      },
      usage: {
        /**
         * Reports it in full. Every `result` line carries `usage` (input/output
         * tokens, cache reads) and `total_cost_usd`, which `claude-usage.utils`
         * maps — so the meter has a numerator, a denominator and a spend.
         */
        unavailableReason: null,
      },
      handoff: {
        kind: 'resume-command',
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
   * The answer rides back on ONE of AskUserQuestion's two channels, chosen by
   * how many questions the card carried: `answers` (a map keyed by question
   * text) for a lone question, `response` (one free-text reply, which REPLACES
   * the structured list) for several. `withResponse` owns that choice and the
   * probe behind it.
   */
  override withAnswer(input: unknown, answer: string): unknown {
    return withResponse(input, answer);
  }

  /** Per-turn `--mcp-config` file paths, written by prepareTurn. */
  private readonly mcpConfigPaths = new WeakMap<AgentTurnInput, string>();

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
    // Taken under the SAME profile the turn will run as: a config directory is
    // where claude keeps its configured MCP servers, so a listing read from
    // the default profile would describe servers this run never loads. It
    // rides the env for the same reason the turn's does — the CLI has no flag
    // for it.
    const stdout = await this.runCommand([...CLAUDE_MCP_LIST_ARGS], {
      ...options,
      cwd: input.cwd,
      processGroup: true,
      timeoutMs: options.timeoutMs ?? CLAUDE_MCP_LIST_TIMEOUT_MS,
      ...(input.configDir
        ? { env: { [CLAUDE_CONFIG_DIR_ENV]: input.configDir } }
        : {}),
    });
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
      // The CLI's OWN per-folder list — the state its `/mcp` panel shows and
      // the one `setMcpServerEnabled` writes. Servers of every scope.
      disabled:
        homeConfig === null
          ? []
          : readDisabledServers(parseHomeConfig(homeConfig), cwd),
      // A `.mcp.json` REJECTION, which is a different question and one geniro
      // cannot undo: the CLI unions every source's copy of that list.
      lockedOff: [...userDisabled],
    };
  }

  /**
   * Switch one server for one folder by editing the CLI's own config.
   *
   * `projects[<cwd>].disabledMcpServers` in `~/.claude.json` — probe-verified
   * on 2.1.222 (see `claude.const.ts`): a name there makes the next turn report
   * that server `disabled` instead of dialling it, whatever scope defined it.
   *
   * Taken under `proper-lockfile` at `<config>.lock`, which is the SAME lock
   * the CLI takes for its own writes (its `ELOCKED` / `Config lock compromised`
   * strings are that package's). Without it a concurrent `claude` write and
   * this one would be a read-modify-write race over a file holding the user's
   * whole CLI state — a lost update there is real data loss, not a lost toggle.
   */
  override async setMcpServerEnabled(
    cwd: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    const file = join(
      this.claudeOptions.homeDir ?? homedir(),
      CLAUDE_MODEL_CACHE_FILE,
    );
    const release = await lock(file, {
      lockfilePath: `${file}${CLAUDE_CONFIG_LOCK_SUFFIX}`,
      retries: CLAUDE_CONFIG_LOCK_RETRIES,
    });
    try {
      // Re-read INSIDE the lock: whatever the panel last listed may be minutes
      // old, and the CLI may have written since.
      // STRICT here, unlike the reader: an unparseable config treated as
      // empty would be rewritten as `{projects: {...}}` and take the user's
      // entire CLI state with it. Refusing costs a toggle; guessing costs
      // their history, their account record, and every project's settings.
      const source = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`${file} is not a JSON object`);
      }
      const config = parsed as ClaudeHomeConfig;
      const next = withDisabledServer(config, cwd, server, enabled);
      if (next === config) {
        return; // already in that state — never rewrite the user's config
      }
      // tmp+rename, so a crash mid-write cannot truncate the file holding the
      // user's whole CLI state. The lock covers concurrent WRITERS; this
      // covers the process dying between them.
      await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    } finally {
      await release();
    }
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
    // Claude's endpoint is a per-turn config file `prepareTurn` writes from
    // this same field, so having it IS the grant.
    // `isolateMcpServers` WITHHOLDS the config below, geniro's own call server
    // included — so a turn carrying both would be told to route work through
    // `call_agent` with no such tool registered, which the adapter rules call
    // out by name as silent by construction. Nothing sets the two together
    // today; saying so here is what keeps that true if something ever does.
    const granted = Boolean(input.mcpEndpoint) && !input.isolateMcpServers;
    const systemPrompt = this.composeSystemPrompt(input, granted);
    if (systemPrompt) {
      args.push(CLAUDE_APPEND_SYSTEM_PROMPT_FLAG, systemPrompt);
    }
    if (this.spawnsOnPermissionDialogue(input)) {
      // acceptEdits/plan map by name. `ask` is the CLI's `default`, and so is
      // an auto turn that must be able to ask: `--dangerously-skip-permissions`
      // strips AskUserQuestion (it leaves the turn no channel to ask on), so
      // that turn spawns on the dialogue instead. Unattended semantics are not
      // lost — the DAEMON becomes the bypass, auto-approving every plain
      // permission request at its approval seam and reserving the human card
      // for genuine questions.
      args.push(
        CLAUDE_PERMISSION_MODE_FLAG,
        input.approvalMode === 'ask' || input.approvalMode === 'auto'
          ? CLAUDE_PERMISSION_MODE_DEFAULT
          : (input.approvalMode ?? CLAUDE_UNSET_MODE_FALLBACK),
      );
      args.push(
        CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
        CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
      );
    } else if (input.approvalMode === 'auto') {
      args.push(CLAUDE_SKIP_PERMISSIONS_FLAG);
    }
    if (input.isolateMcpServers) {
      // The one path that passes the strict flag. Without it the probe loads
      // every server the folder defines just to have them reaped a moment
      // later, and the reap reaches the user's OWN running servers.
      args.push(CLAUDE_MCP_CONFIG_FLAG, CLAUDE_EMPTY_MCP_CONFIG);
      args.push(CLAUDE_STRICT_MCP_CONFIG_FLAG);
      return args;
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
    //
    // The run's config directory rides here too, and ONLY here: it is what
    // decides which account (which subscription) the turn runs as, plus the
    // settings, plugins and history it sees. Set BEFORE `input.env` for the
    // same reason the credentials are — an explicit per-call env stays the
    // last word.
    const env = {
      ...claudeCredentialEnv(),
      ...(input.configDir ? { [CLAUDE_CONFIG_DIR_ENV]: input.configDir } : {}),
      ...input.env,
    };
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
    return this.userMessageLine(input.prompt, input.images);
  }

  /**
   * A message typed while this turn was already running, delivered INTO it.
   *
   * The same line the turn opened with, which is the whole trick: the CLI's
   * stream-json stdin is a conversation, not a one-shot argument, so a second
   * `{"type":"user"}` on a still-open stdin is picked up at the next tool
   * boundary of the turn in flight. Probe-verified on 2.1.222 — a message sent
   * 8 seconds into a 20-second command was acted on at 29 seconds, in the same
   * process. Holding it until the process exits instead (which is what a queue
   * draining on settle does) turns "as soon as possible" into "after
   * everything finishes", and the CLI itself does not behave that way.
   *
   * Reachable only while stdin is open — `keepStdinOpen` is true for every
   * chat turn, since `allowUserQuestions` is set there. A turn spawned without
   * it writes into a closed pipe and `sendUserMessage` reports false, which is
   * exactly the answer the caller needs to keep the message queued.
   */
  protected override buildFollowUpPayload(message: FollowUpMessage): string {
    return this.userMessageLine(message.text, message.images);
  }

  /**
   * One process can serve a whole run's worth of turns — probe-verified on
   * 2.1.223: two user messages written to one still-open stdin produced two
   * `result` lines under ONE `session_id`, and the process exited only when
   * stdin was closed. `system/init` is re-emitted at the head of each turn, so
   * the session saver and the MCP harvest keep seeing what they read today.
   *
   * The predicate is `keepStdinOpen`'s, deliberately reused rather than
   * restated, exactly as `buildApprovalModePayload` reuses it: "can this turn
   * carry a dialogue" and "can this process take another prompt" are the same
   * question about the same open pipe, and a second copy of the condition is
   * how the two would come to disagree.
   */
  protected override canHostSession(input: AgentTurnInput): boolean {
    return this.keepStdinOpen(input);
  }

  /**
   * The next turn opens with the SAME user line the first one did — a
   * stream-json stdin is a conversation, so the CLI reads a `{"type":"user"}`
   * arriving after a `result` as the next prompt rather than as an addition to
   * the last one. Third caller of the one encoder, so the three cannot drift.
   */
  protected override buildNextTurnPayload(message: FollowUpMessage): string {
    return this.userMessageLine(message.text, message.images);
  }

  /**
   * Stop the turn without stopping the process.
   *
   * Probe-verified on 2.1.223: `control_request`/`interrupt` was acknowledged
   * in 2ms and the turn ended with `result subtype=error_during_execution`,
   * the process still alive. That is what lets Stop leave the run's MCP
   * servers — and a browser one of them owns — running.
   *
   * Gated on the same open-stdin predicate as its neighbours: a turn spawned
   * under `--dangerously-skip-permissions` has no channel to be told anything.
   */
  protected override buildInterruptPayload(
    input: AgentTurnInput,
  ): string | undefined {
    if (!this.keepStdinOpen(input)) {
      return undefined;
    }
    return `${JSON.stringify({
      type: 'control_request',
      // Namespaced away from the CLI's own request ids, like the mode change
      // below: both id spaces share this one dialogue, and nothing here
      // correlates a reply.
      request_id: `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}${CLAUDE_INTERRUPT_SUBTYPE}`,
      request: { subtype: CLAUDE_INTERRUPT_SUBTYPE },
    })}\n`;
  }

  /** The CLI's stream-json user line — one encoder, so the two cannot drift. */
  private userMessageLine(
    text: string,
    images: TurnImage[] | undefined,
  ): string {
    return `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        // Attached images ride as real base64 content blocks — the CLI's
        // stream-json input accepts the Messages-API block shape, so the model
        // SEES the image directly (probe-verified on claude 2.1.220, in either
        // block order). Handing over a path instead would cost a Read
        // round-trip and put an image behind the permission gate.
        content: [...buildImageBlocks(images), { type: 'text', text }],
      },
    })}\n`;
  }

  /**
   * Whether this turn spawns holding the stdio permission dialogue —
   * `--permission-prompt-tool stdio`, which is what lets the CLI raise a
   * `can_use_tool` control_request mid-turn.
   *
   * ONE predicate, read by `buildArgs` (which decides the argv) and by
   * `keepStdinOpen` (which decides whether a verdict has a way back in). They
   * are the same question and must never be answered differently: a turn given
   * the dialogue with stdin already closed parks on a request nobody can
   * answer, and a turn denied the dialogue with stdin held open leaks a
   * process per turn.
   *
   * Two turns are outside it: an `auto` turn that will not ask (it spawns
   * under `--dangerously-skip-permissions`, which wires no prompt tool at
   * all), and a turn that named no mode at all — which after
   * {@link CLAUDE_UNSET_MODE_FALLBACK} means a geniro-INTERNAL turn, never a
   * user's chat. Those probes read one `system/init` line and are cancelled;
   * handing them a permission dialogue and an open stdin buys nothing.
   */
  private spawnsOnPermissionDialogue(input: AgentTurnInput): boolean {
    if (input.approvalMode === undefined) {
      return false;
    }
    return input.approvalMode !== 'auto' || input.allowUserQuestions === true;
  }

  protected override keepStdinOpen(input: AgentTurnInput): boolean {
    return this.spawnsOnPermissionDialogue(input);
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

  protected override buildApprovalModePayload(
    input: AgentTurnInput,
    mode: AgentApprovalMode,
  ): string | undefined {
    // The predicate is `keepStdinOpen`'s, deliberately reused rather than
    // restated: "can this turn be re-moded" and "does this turn hold the stdin
    // dialogue" are the SAME question, and a second copy of the condition is
    // how the two would come to disagree after a change to buildArgs. A turn
    // spawned under --dangerously-skip-permissions has no prompt tool, so a
    // gate cannot be reintroduced into it by any message.
    if (!this.keepStdinOpen(input)) {
      return undefined;
    }
    return `${JSON.stringify({
      type: 'control_request',
      // Namespaced away from the CLI's own request ids — both id spaces share
      // this one dialogue. Not unique per call by design: the CLI answers with
      // the id it was given and nothing correlates a reply here, so a counter
      // would be state on the adapter serving N concurrent turns.
      request_id: `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}${CLAUDE_SET_PERMISSION_MODE_SUBTYPE}`,
      request: {
        subtype: CLAUDE_SET_PERMISSION_MODE_SUBTYPE,
        // geniro's `auto` is NOT the CLI's. It is the DAEMON auto-approving at
        // its own seam, so the CLI must keep prompting — which is `default`,
        // exactly what `buildArgs` spawns an auto question-capable turn with.
        //
        // The collision is real and recent: 2.1.227 added a `--permission-mode
        // auto` of its own, so passing the string through would now be
        // ACCEPTED and would hand the turn to the CLI's auto-approval instead
        // of the daemon's — silently, since an accepted control request says
        // nothing. It used to be merely rejected. Do not "simplify" this to
        // pass the mode straight through.
        mode:
          mode === 'auto' || mode === 'ask'
            ? CLAUDE_PERMISSION_MODE_DEFAULT
            : mode,
      },
    })}\n`;
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapClaudeMessage(obj);
  }
}
