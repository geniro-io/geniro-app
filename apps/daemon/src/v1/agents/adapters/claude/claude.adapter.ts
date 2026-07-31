import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeCredentialEnv } from '../../utils/child-env';
import type {
  AdapterQuestion,
  AgentApprovalMode,
  AgentEvent,
  AgentModel,
  AgentTurnInput,
  InstalledApprovalSupport,
  InstalledCapabilities,
} from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';
import {
  CLAUDE_APPEND_SYSTEM_PROMPT_FLAG,
  CLAUDE_BASE_ARGS,
  CLAUDE_CONFIG,
  CLAUDE_DENY_MESSAGE,
  CLAUDE_EFFORT_FLAG,
  CLAUDE_MCP_CONFIG_DIR_NAME,
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_MCP_TOOL_TIMEOUT_ENV,
  CLAUDE_MCP_TOOL_TIMEOUT_MS,
  CLAUDE_MODEL_FLAG,
  CLAUDE_PARTIAL_MESSAGES_FLAG,
  CLAUDE_PERMISSION_MODE_DEFAULT,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
  CLAUDE_RESUME_FLAG,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  CLAUDE_STRICT_MCP_CONFIG_FLAG,
} from './claude.const';
import type { ClaudeAdapterOptions } from './claude.types';
import { buildImageBlocks } from './utils/claude-images.utils';
import {
  sweepStaleTurnMcpConfigs,
  writeTurnMcpConfig,
} from './utils/claude-mcp-config.utils';
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
  readonly config = CLAUDE_CONFIG;

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
   * A caller turn's MCP config is a per-turn 0600 file: the call token must
   * never ride argv (visible in `ps`), so argv carries only the path.
   */
  protected override prepareTurn(
    input: AgentTurnInput,
  ): (() => void) | undefined {
    if (!input.mcpEndpoint) {
      return undefined;
    }
    const dir =
      this.claudeOptions.mcpConfigDir ??
      join(tmpdir(), CLAUDE_MCP_CONFIG_DIR_NAME);
    const path = writeTurnMcpConfig(dir, input.mcpEndpoint);
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
   *
   * The alias floor comes from `config.builtinModels` — the declared fallback
   * surface — never from the const behind it, so config stays the one place a
   * CLI's static values are read.
   */
  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve(
      claudeModels(this.config.builtinModels, this.claudeOptions.homeDir),
    );
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
    if (input.systemPrompt) {
      args.push(CLAUDE_APPEND_SYSTEM_PROMPT_FLAG, input.systemPrompt);
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
    const mcpConfigPath = this.mcpConfigPaths.get(input);
    if (mcpConfigPath) {
      // --strict-mcp-config: ONLY our server — the user's global MCP config
      // must not leak into a headless team turn.
      args.push(
        CLAUDE_MCP_CONFIG_FLAG,
        mcpConfigPath,
        CLAUDE_STRICT_MCP_CONFIG_FLAG,
      );
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
