import type {
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
  CURSOR_CONFIG,
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
  readonly config = CURSOR_CONFIG;

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
    return parseCursorModels(stdout) ?? [...this.config.builtinModels];
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
