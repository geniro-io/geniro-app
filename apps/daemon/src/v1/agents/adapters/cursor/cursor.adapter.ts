import { AgentKind } from '../../../runs/runs.types';
import type {
  AdapterConfig,
  AgentApprovalMode,
  AgentCommandOptions,
  AgentEvent,
  AgentModel,
  AgentTurnInput,
} from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';
import {
  CURSOR_API_KEY_ENV,
  CURSOR_API_KEY_SOURCE_ENV,
  CURSOR_BASE_ARGS,
  CURSOR_MODEL_FLAG,
  CURSOR_MODELS_SUBCOMMAND,
  CURSOR_RESUME_FLAG,
  CURSOR_SYSTEM_PROMPT_SEPARATOR,
  CURSOR_TRUST_FLAG,
} from './cursor.const';
import { withImagePaths } from './utils/cursor-images.utils';
import { mapCursorMessage } from './utils/cursor-message.utils';
import { parseCursorModels } from './utils/cursor-models.utils';

/**
 * Drives `cursor-agent` headlessly. The prompt is a positional argument (Cursor
 * reads it from argv, not stdin), so stdin is closed immediately — the base
 * class's no-payload default — which also prevents the CLI from dropping into
 * its interactive login TTY when unauthenticated; it fails fast instead,
 * surfacing a non-zero exit as an error event. The Cursor key is NOT inherited
 * from the daemon's environment — `spawn-cli` strips every `GENIRO_`-prefixed
 * var (including `GENIRO_CURSOR_API_KEY`) from the child env, and this adapter
 * re-injects it as `CURSOR_API_KEY` for its own child ONLY (see
 * {@link CursorAdapter.buildEnv}).
 */
export class CursorAdapter extends AgentAdapter {
  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.CursorAgent,
      /**
       * cursor-agent has no per-turn approval channel at all (its permissions
       * are the `--force` flag plus the static allow/deny list in
       * `~/.cursor/cli-config.json`), so it has no way to ask the user
       * anything mid-turn either.
       */
      questionToolName: null,
      approval: {
        /**
         * `auto` is the only honest entry: `--force` plus the static allow/deny
         * list in `~/.cursor/cli-config.json` IS this CLI's permission model,
         * and there is no per-turn channel to hold a tool call on. Offering
         * `ask` would be a control that changes nothing.
         */
        modes: ['auto'],
        /** Nothing to probe — the one mode it has needs no binary to confirm it. */
        probedModes: [],
        /** Nothing is probed, so nothing can degrade on a probe result. */
        degradeOnProbeFail: {},
        /**
         * Everything becomes `auto`, and anything else asked for is REPORTED
         * rather than quietly ignored: a workflow node may still be authored
         * with `ask` (the graph schema is CLI-agnostic), and a silent degrade
         * there would read as enforced permissions that never existed.
         */
        soleModeDegradeReason: (requested: AgentApprovalMode): string =>
          `cursor-agent has no approval callback — approval '${requested}' degrades to auto-approve for this turn`,
      },
      /**
       * Nothing to offer: cursor-agent has no reasoning-effort flag, because
       * it folds effort INTO the model id instead — `sonnet-4-thinking`,
       * `gpt-5.2-high`. A level here would be a second control over the same
       * thing, and the CLI would reject the flag; the model chip already IS
       * the effort chip for this CLI.
       */
      efforts: [],
      /**
       * The set offered when the CLI cannot be asked — an install too old to
       * have the `models` subcommand, or one that is not signed in. These are
       * the ids cursor-agent's own `--model` help gives as examples, so they
       * are the only ones documented to work without asking the account.
       */
      builtinModels: [
        { id: 'gpt-5', label: 'gpt-5', source: 'builtin' },
        { id: 'sonnet-4', label: 'sonnet-4', source: 'builtin' },
        {
          id: 'sonnet-4-thinking',
          label: 'sonnet-4-thinking',
          source: 'builtin',
        },
      ],
      skillRoots: {
        /** It has no skills convention — only claude does. */
        skills: [],
        /** `<root>/.cursor/commands/**.md`. */
        commands: [['.cursor', 'commands']],
      },
      /**
       * cursor-agent's stream-json has no partial-output mode — its assistant
       * lines arrive whole — so a turn never streams increments.
       */
      liveStream: null,
      /**
       * Nothing to report: cursor-agent has no built-in slash commands and no
       * equivalent of claude's `system/init` list — `.cursor/commands` on disk
       * is the whole of what it can be invoked with.
       */
      reportedCommands: null,
      mcp: {
        /**
         * cursor-agent keeps its own persistent MCP trust store, and a server
         * it has not trusted is silently unavailable to the model — so the
         * daemon must PROVE the endpoint is reachable on this machine before a
         * run admits a cursor caller, rather than launch a turn whose call
         * tools quietly do nothing.
         */
        callToolsRequireTrustProbe: true,
        /**
         * There is no `--mcp-config` flag: the only way in is a `geniro` entry
         * merged into the run cwd's `.cursor/mcp.json` for the turn and
         * removed after it.
         */
        endpointRequiresCwdConfig: true,
      },
      /** Cursor's subscription TUI is an explicit M4 scope exclusion (deferred). */
      terminal: null,
    };
  }

  /**
   * `cursor-agent models` (== `--list-models`) — "List available models for
   * this account". It is the only CLI here that can actually be asked, so the
   * list is live and stays in sync on its own. Builds older than the
   * subcommand treat `models` as a PROMPT and drop into the sign-in flow
   * instead of answering, which the timeout turns into a null; the built-in
   * set covers that and the unauthenticated case alike.
   *
   * That fallback is read from `config.builtinModels` — the declared floor —
   * rather than the const behind it, so config is genuinely the one read
   * surface for a CLI's static values. It is spread, not handed out: the
   * config's array is readonly and callers get a list of their own.
   */
  override async listModels(
    options: AgentCommandOptions = {},
  ): Promise<AgentModel[]> {
    const stdout = await this.runCommand(
      [...CURSOR_MODELS_SUBCOMMAND],
      options,
    );
    return parseCursorModels(stdout) ?? [...this.getConfig().builtinModels];
  }

  protected buildArgs(input: AgentTurnInput): string[] {
    const args = [...CURSOR_BASE_ARGS];
    if (input.trustWorkspace) {
      args.push(CURSOR_TRUST_FLAG);
    }
    if (input.model) {
      args.push(CURSOR_MODEL_FLAG, input.model);
    }
    if (input.resumeSessionId) {
      args.push(CURSOR_RESUME_FLAG, input.resumeSessionId);
    }
    // The prompt travels on STDIN (buildStdinPayload), never argv: argv is
    // `ps`-visible to every local account, and the composed prompt carries the
    // user's task text plus upstream nodes' outputs — the same threat model
    // that keeps call tokens off argv (0600 file there, stdin here).
    return args;
  }

  protected override buildStdinPayload(input: AgentTurnInput): string {
    // cursor-agent has no system-prompt flag and no approval callback: a
    // graph node's role is prepended to the prompt text, and every non-auto
    // approval mode degrades to auto-approve (`--force` — the executor/chat
    // surface the degrade to the user). In `-p` mode with no positional prompt
    // the CLI reads the prompt from stdin until EOF (spawn-cli ends stdin
    // right after the payload).
    const prompt = withImagePaths(input.prompt, input.images);
    return input.systemPrompt
      ? `${input.systemPrompt}${CURSOR_SYSTEM_PROMPT_SEPARATOR}${prompt}`
      : prompt;
  }

  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    // The daemon receives the Keychain-sourced Cursor key as GENIRO_CURSOR_API_KEY
    // (a GENIRO_-prefixed var that spawn-cli strips from every child env). Re-inject
    // it as CURSOR_API_KEY for THIS child only, so the key never reaches the claude
    // agent. Honor an explicit per-call override in input.env if one is given.
    const cursorApiKey = process.env[CURSOR_API_KEY_SOURCE_ENV];
    return {
      ...(cursorApiKey ? { [CURSOR_API_KEY_ENV]: cursorApiKey } : {}),
      ...input.env,
    };
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapCursorMessage(obj);
  }
}
