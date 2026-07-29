import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAgentBinary } from '../../utils/agent-binary';
import { claudeCredentialEnv } from '../../utils/child-env';
import { asArray, asBoolean, asRecord, asString } from '../../utils/json-util';
import type {
  AgentCommandOptions,
  AgentEvent,
  AgentModel,
  AgentSkillEntry,
  AgentSkillsInput,
  AgentTurnInput,
} from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import { probeClaudeCommands } from './claude-commands';
import {
  helpAdvertisesPartialMessages,
  mapClaudeStreamEvent,
  mapClaudeThinkingTokens,
  PARTIAL_MESSAGES_FLAG,
} from './claude-live-stream';
import { claudeModels } from './claude-models';
import { scanClaudeSkills } from './claude-skills';
import { readClaudeUsage } from './claude-usage';
import { buildImageBlocks } from './image-blocks';

/**
 * Default `MCP_TOOL_TIMEOUT` for turns that carry the call tools: a sync
 * call_agent legitimately runs for minutes (a full callee turn), far past the
 * CLI's own default MCP client timeout.
 */
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

/** Claude-specific constructor options (the bag stays a test seam). */
export interface ClaudeAdapterOptions extends AgentAdapterOptions {
  /**
   * Directory for the per-turn `--mcp-config` files (the daemon passes its
   * userData tmp dir); falls back to the OS tmpdir for standalone/spec use.
   */
  mcpConfigDir?: string;
  /** Home dir holding `.claude.json` (test seam); defaults to the real one. */
  homeDir?: string;
  /**
   * Root for the throwaway workspace the command-catalog probe runs in (the
   * daemon passes its userData tmp dir); falls back to the OS tmpdir.
   */
  probeRootDir?: string;
}

/**
 * Map one parsed line of `claude -p --output-format stream-json` to normalized
 * events. Shapes verified against a live `claude` 2.1.196 capture:
 * - `system/init` carries the `session_id` (→ resume slot).
 * - `assistant.message.content[]` blocks: `text` / `thinking` / `tool_use`.
 * - `user.message.content[]` `tool_result` blocks close a tool call.
 * - `result` carries the final text, `usage`, `total_cost_usd`, `stop_reason`.
 * - `control_request` (`can_use_tool`) is the permission pause of the stdin
 *   control protocol (`--permission-prompt-tool stdio`, `ask` approval mode);
 *   verified against a live 2.1.199 capture.
 * - Anything else (`hook_*`, `post_turn_summary`, `rate_limit_event`, …) is
 *   ignored — the stream legitimately includes event types this turn doesn't model.
 */
export function mapClaudeMessage(obj: unknown): AgentEvent[] {
  const root = asRecord(obj);
  if (!root) {
    return [];
  }

  switch (asString(root.type)) {
    case 'system': {
      if (asString(root.subtype) === 'thinking_tokens') {
        return mapClaudeThinkingTokens(root);
      }
      if (asString(root.subtype) === 'init') {
        const events: AgentEvent[] = [];
        const sessionId = asString(root.session_id);
        if (sessionId) {
          events.push({ type: 'session', sessionId });
        }
        // init's `slash_commands` is the session's authoritative invokable
        // set (built-ins + plugins + skills + commands) — harvested for the
        // composer's `/` autocomplete. Verified live on 2.1.211.
        const commands = asArray(root.slash_commands)
          .map((entry) => asString(entry))
          .filter((entry): entry is string => entry !== null && entry !== '');
        if (commands.length > 0) {
          events.push({ type: 'slash_commands', commands });
        }
        return events;
      }
      return [];
    }

    case 'stream_event':
      return mapClaudeStreamEvent(root);

    case 'assistant': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      const events: AgentEvent[] = [];
      for (const block of asArray(message.content)) {
        const b = asRecord(block);
        if (!b) {
          continue;
        }
        switch (asString(b.type)) {
          case 'text': {
            const text = asString(b.text);
            if (text) {
              events.push({ type: 'text', text });
            }
            break;
          }
          case 'thinking': {
            const text = asString(b.thinking) ?? asString(b.text);
            if (text) {
              events.push({ type: 'reasoning', text });
            }
            break;
          }
          case 'tool_use': {
            events.push({
              type: 'tool_call',
              id: asString(b.id) ?? '',
              name: asString(b.name) ?? '',
              input: b.input ?? null,
            });
            break;
          }
          default:
            break;
        }
      }
      return events;
    }

    case 'user': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      const events: AgentEvent[] = [];
      for (const block of asArray(message.content)) {
        const b = asRecord(block);
        if (!b || asString(b.type) !== 'tool_result') {
          continue;
        }
        events.push({
          type: 'tool_result',
          id: asString(b.tool_use_id) ?? '',
          name: null,
          result: b.content ?? null,
          isError: asBoolean(b.is_error),
        });
      }
      return events;
    }

    case 'control_request': {
      const request = asRecord(root.request);
      const id = asString(root.request_id);
      if (!request || !id || asString(request.subtype) !== 'can_use_tool') {
        return [];
      }
      return [
        {
          type: 'approval_request',
          id,
          toolName: asString(request.tool_name) ?? '',
          input: request.input ?? null,
          // AskUserQuestion carries requires_user_interaction: true (verified
          // live on 2.1.202) — the M4 question-vs-permission discriminator.
          requiresUserInteraction: asBoolean(request.requires_user_interaction)
            ? true
            : undefined,
        },
      ];
    }

    case 'result': {
      if (asBoolean(root.is_error)) {
        return [
          {
            type: 'error',
            message:
              asString(root.result) ??
              asString(root.error) ??
              'claude run failed',
          },
        ];
      }
      return [
        {
          type: 'turn_complete',
          usage: readClaudeUsage(root),
          stopReason: asString(root.stop_reason),
          finalText: asString(root.result) ?? null,
        },
      ];
    }

    default:
      return [];
  }
}

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
  readonly kind = 'claude' as const;

  /**
   * Probe-verified: a plain chat turn under `--permission-mode default
   * --permission-prompt-tool stdio` offers this tool, and its request arrives
   * as `can_use_tool` with `requires_user_interaction: true`.
   */
  readonly questionToolName = 'AskUserQuestion';

  /** Per-turn `--mcp-config` file paths, written by prepareTurn. */
  private readonly mcpConfigPaths = new WeakMap<AgentTurnInput, string>();

  constructor(private readonly claudeOptions: ClaudeAdapterOptions = {}) {
    super(claudeOptions);
  }

  // Resolved per turn so the Settings cliPaths override (GENIRO_CLAUDE_BIN on
  // the daemon env) takes effect without reconstructing the adapter.
  protected get command(): string {
    return resolveAgentBinary('claude');
  }

  /**
   * Delete any `mcp-*.json` files a prior daemon launch left in the config dir
   * (a crash/SIGKILL skips the per-turn disposer). Called once at boot — the
   * tokens inside are already dead (the registry is in-memory), so this is
   * hygiene, not a security fix. Best-effort: a missing dir or a busy file
   * never blocks boot.
   */
  sweepStaleConfigs(): void {
    const dir = this.claudeOptions.mcpConfigDir;
    if (!dir) {
      return;
    }
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('mcp-') && name.endsWith('.json')) {
          rmSync(join(dir, name), { force: true });
        }
      }
    } catch {
      // No dir yet, or an unreadable entry — nothing to sweep.
    }
  }

  /**
   * A caller turn's MCP config is a per-turn 0600 file: the call token must
   * never ride argv (visible in `ps`), so argv carries only the path.
   */
  protected override prepareTurn(
    input: AgentTurnInput,
  ): (() => void) | undefined {
    if (!input.mcpEndpoint) {
      return undefined;
    }
    const dir = this.claudeOptions.mcpConfigDir ?? join(tmpdir(), 'geniro-mcp');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `mcp-${randomUUID()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          geniro: {
            type: 'http',
            url: input.mcpEndpoint.url,
            headers: { Authorization: `Bearer ${input.mcpEndpoint.token}` },
          },
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    this.mcpConfigPaths.set(input, path);
    return () => {
      this.mcpConfigPaths.delete(input);
      rmSync(path, { force: true });
    };
  }

  /**
   * claude has no list-models subcommand to run, so nothing is spawned: the
   * list is the documented tier aliases plus the account-specific models the
   * CLI caches in `~/.claude.json` for its own picker. Synchronous work behind
   * an async signature — the contract is shared with cursor, which really does
   * shell out.
   */
  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve(claudeModels(this.claudeOptions.homeDir));
  }

  override listSkills(input: AgentSkillsInput): Promise<AgentSkillEntry[]> {
    return scanClaudeSkills(input);
  }

  /** Memoized: `--help` is asked once per adapter instance, not once per turn. */
  private liveStreamSupport: Promise<boolean> | null = null;

  override supportsLiveStream(
    options: AgentCommandOptions = {},
  ): Promise<boolean> {
    this.liveStreamSupport ??= this.runCommand(['--help'], options).then(
      helpAdvertisesPartialMessages,
    );
    return this.liveStreamSupport;
  }

  override listReportedCommands(
    options: AgentCommandOptions = {},
  ): Promise<string[]> {
    return probeClaudeCommands(
      {
        start: (turn, onEvent) => this.start(turn, onEvent),
        probeRootDir: this.claudeOptions.probeRootDir ?? tmpdir(),
      },
      options,
    );
  }

  protected buildArgs(input: AgentTurnInput): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ];
    if (input.streamPartials) {
      args.push(PARTIAL_MESSAGES_FLAG);
    }
    if (input.model) {
      args.push('--model', input.model);
    }
    if (input.resumeSessionId) {
      args.push('--resume', input.resumeSessionId);
    }
    if (input.systemPrompt) {
      args.push('--append-system-prompt', input.systemPrompt);
    }
    if (input.approvalMode === 'auto' && input.allowUserQuestions) {
      // `--dangerously-skip-permissions` STRIPS AskUserQuestion, so an auto
      // turn that must be able to ask spawns on the stdio dialogue instead
      // (`default` is the CLI's name for ask). Unattended semantics are not
      // lost — the DAEMON becomes the bypass, auto-approving every plain
      // permission request at its approval seam and reserving the human card
      // for genuine questions.
      args.push('--permission-mode', 'default');
      args.push('--permission-prompt-tool', 'stdio');
    } else if (input.approvalMode === 'auto') {
      args.push('--dangerously-skip-permissions');
    } else if (input.approvalMode) {
      // ask/acceptEdits/plan all hold the stdio approval dialogue; `ask` is
      // the CLI's `default` permission mode, the other modes map by name.
      args.push(
        '--permission-mode',
        input.approvalMode === 'ask' ? 'default' : input.approvalMode,
      );
      args.push('--permission-prompt-tool', 'stdio');
    }
    const mcpConfigPath = this.mcpConfigPaths.get(input);
    if (mcpConfigPath) {
      // --strict-mcp-config: ONLY our server — the user's global MCP config
      // must not leak into a headless team turn.
      args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
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
      MCP_TOOL_TIMEOUT: String(
        input.mcpEndpoint.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS,
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
          : { behavior: 'deny', message: 'Denied by the user in Geniro' },
      },
    })}\n`;
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapClaudeMessage(obj);
  }
}
