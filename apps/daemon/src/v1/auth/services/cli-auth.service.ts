import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentMcpService } from '../../agents/services/agent-mcp.service';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { CacheResetService } from '../../agents/services/cache-reset.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { childProcessHandle } from '../../agents/utils/child-handle';
import { ensureFolderlessDir } from '../../agents/utils/folderless-dir';
import { resolveValidConfigDir } from '../../agents/utils/resolve-config-dir';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import type { AgentKind } from '../../runs/runs.types';
import type { LoginSession, LoginStatus, LogoutResult } from '../auth.types';
import {
  LOGIN_OUTPUT_TAIL_CHARS,
  LOGIN_TIMEOUT_MS,
  SETTLED_LOGIN_RETENTION_MS,
} from '../auth.types';
import {
  firstUrlIn,
  lastProgressLine,
  plainTerminalText,
} from '../utils/login-output';

/** How long `start` waits for the CLI to print its URL before answering anyway. */
const URL_WAIT_MS = 4_000;
/** Poll interval while waiting for the URL — short, since this blocks a request. */
const URL_POLL_MS = 100;
/** A sign-out clears a file and exits; it has no reason to take longer. */
const LOGOUT_TIMEOUT_MS = 20_000;
/**
 * The pause after each re-check of a server whose sign-in is `verifying`: the
 * first re-check runs at once, since the user may have authorized before the
 * CLI exited, then it backs off — each re-check is a real dial of the server.
 */
const VERIFY_FIRST_DELAY_MS = 2_000;
const VERIFY_MAX_DELAY_MS = 10_000;
const VERIFY_BACKOFF = 1.5;

/** One tracked sign-in: its public state plus the child we are watching. */
interface LoginRun {
  session: LoginSession;
  child: ChildProcess | null;
  /** The TAIL of what the CLI printed — see {@link LOGIN_OUTPUT_TAIL_CHARS}. */
  output: string;
  /**
   * What the CLI printed since a code was SUBMITTED, or null before one was.
   *
   * The code prompt is judged on this once it exists, never on `output`: the
   * whole buffer still holds the prompt that was just answered ("Paste code
   * here if prompted"), so re-reading it put the run straight back to
   * `needs_code` on the CLI's next line and the code field reappeared under a
   * user who had already pasted. A prompt printed AFTER the submit — a wrong
   * code, asked again — lands here and asks again, as it should.
   */
  sinceCode: string | null;
  /** The pending forget of an ended run — see {@link SETTLED_LOGIN_RETENTION_MS}. */
  evictTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The MCP server this sign-in is for, or null for the CLI's own account.
   *
   * The only thing the two flows do differently after the spawn: a server
   * sign-in's verdict is read out of the CLI's WORDS (`mcpLoginFailed`), since
   * under a pty the exit status belongs to the `script` wrapper and says
   * nothing about the CLI beneath it.
   */
  server: string | null;
  /**
   * The folder a SERVER sign-in was run in, or null for an account sign-in.
   *
   * Where the server is re-checked until it connects, and where the reach of
   * the sign-in is measured from when it does: a CLI reads its MCP
   * configuration at spawn, so a connector the user has just authenticated
   * reaches the config and not the processes already holding it.
   */
  cwd: string | null;
  /** The profile a server sign-in ran under — where its re-checks run too. */
  configDir: string | null;
}

/**
 * Signs a CLI in and out WITHOUT opening a terminal window.
 *
 * The ONLY way a CLI is signed in or out. `HandoffService` carried a
 * `loginTarget`/`logoutTarget`/`mcpLoginTarget` trio that RESOLVED an invocation
 * for the user's own terminal, kept as "the fallback" while this service took the
 * ordinary case. Every caller has since moved here, and a fallback nothing can
 * reach is not a fallback — it is a second sign-in mechanism free to drift from
 * the one that runs. It went with the last caller; `v1/handoff` now resolves one
 * thing only, a conversation.
 *
 * Why the daemon may run these at all, when `AdapterConfig.auth.loginArgs` once
 * said it resolves and never runs: that instruction generalised a probe of `mcp
 * login`, which refuses a non-TTY stdin outright. Re-probed on claude 2.1.228 and
 * cursor-agent 2026.08.11-e8db854, the ACCOUNT commands do not — `auth logout`
 * exits 0 with stdin closed, and both logins print a usable URL, open the browser
 * themselves, and (cursor, measured) poll to completion needing no input.
 *
 * Every child goes through the adapter (`runLogin`/`runLogout`) and registers with
 * `ProcessRegistry`, so a sign-in the user abandons still dies on shutdown — a
 * login is a DETACHED group with a browser opener under it, which is exactly the
 * shape that outlives an unregistered spawn.
 */
@Injectable()
export class CliAuthService {
  private readonly logger = new Logger(CliAuthService.name);
  private readonly runs = new Map<string, LoginRun>();

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly caches: CacheResetService,
    private readonly mcp: AgentMcpService,
  ) {}

  /**
   * Drop what this CLI told us about itself, because it is now a different
   * account.
   *
   * The one account change geniro can OBSERVE — it ran the command — and so the
   * one that needs no clock. A subscription decides which models exist and what
   * each of them offers, and none of that moves the CLI's `--version`, which is
   * the only other check a stored answer is held to. Without this, signing in
   * would leave the composer offering the previous account's models until the
   * refresh window lapsed.
   *
   * EVERY cache of that CLI's answers, not only the durable store: the
   * in-memory mirrors are consulted first, and an ask already running when the
   * account changed would otherwise file the previous account's answer after
   * the forget. `CacheResetService.forgetAgent` is the one list of them, the
   * per-agent twin of the menu bar's reset.
   *
   * The same change reaches the PROCESSES too: every session this CLI is
   * holding was started under the credentials the user just replaced, so each
   * is retired from its next turn on (`AgentSessionRegistry.markAgentStale`).
   * Without it, the sign-in a failed turn offers for an expired token would
   * leave that chat's very next message on the process that produced the 401.
   *
   * Called on the ACCOUNT flows only: an MCP server sign-in changes which tools
   * a turn has, not which models the CLI sells, and that staleness is already
   * answered next door by retiring the folder's sessions.
   */
  private accountChanged(agent: AgentKind, because: string): void {
    const dropped = this.caches.forgetAgent(agent);
    if (dropped > 0) {
      this.logger.log(
        `dropped ${dropped} cached ${agent} answer(s) — ${because}`,
      );
    }
    const retired = this.sessions.markAgentStale(agent, because, 'account');
    if (retired > 0) {
      this.logger.log(
        `${retired} ${agent} session(s) will restart on their next turn — ${because}`,
      );
    }
  }

  /**
   * Sign a CLI out, here and now.
   *
   * Answers a REFUSAL as a 200 carrying the adapter's own reason, the way every
   * other auth answer in this app does — "this CLI has no sign-out command" is
   * the answer to the question, not an error in asking it.
   */
  async logout(input: {
    agent: AgentKind;
    configDir?: string;
  }): Promise<LogoutResult> {
    const adapter = this.adapters.for(input.agent);
    const { logoutArgs, logoutUnavailableReason } = adapter.getConfig().auth;
    if (logoutArgs === null) {
      return {
        agent: input.agent,
        ok: false,
        unavailableReason:
          logoutUnavailableReason ?? `${input.agent} has no sign-out command`,
      };
    }
    const ok = await adapter.runLogout({
      configDir: this.resolveConfigDir(input.configDir),
      timeoutMs: LOGOUT_TIMEOUT_MS,
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `auth:logout:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    });
    if (ok) {
      this.accountChanged(input.agent, 'signed out');
    }
    return {
      agent: input.agent,
      ok,
      // No sentence invented for the failure: the CLI's stdout is not shown here
      // (see `lastProgressLine` on why auth output is not forwarded wholesale),
      // and the renderer's own re-probe is what tells the user where they stand.
      unavailableReason: ok
        ? null
        : `${input.agent} could not complete the sign-out — open it in a terminal to see why`,
    };
  }

  /**
   * Start a sign-in and answer as soon as there is something to show.
   *
   * Waits a beat for the CLI to print its URL rather than returning instantly
   * with `url: null`: the link is the one thing the user may need if the browser
   * did not open, and a caller that had to poll for it would flash an empty
   * panel first. The wait is capped, and a slow CLI simply answers `waiting`
   * with the URL arriving on a later `status` read.
   */
  async startLogin(input: {
    agent: AgentKind;
    configDir?: string;
  }): Promise<LoginSession> {
    const adapter = this.adapters.for(input.agent);
    const { loginArgs, loginUnavailableReason } = adapter.getConfig().auth;
    if (loginArgs === null) {
      throw new BadRequestException(
        'CLI_LOGIN_UNSUPPORTED',
        loginUnavailableReason ?? `${input.agent} has no sign-in command`,
      );
    }
    const id = randomUUID();
    const run: LoginRun = {
      session: {
        id,
        agent: input.agent,
        status: 'waiting',
        url: null,
        message: null,
      },
      child: null,
      output: '',
      sinceCode: null,
      evictTimer: null,
      server: null,
      cwd: null,
      configDir: null,
    };
    this.runs.set(id, run);

    // Not awaited: the child outlives this request by design, and the promise is
    // what carries its exit into the session state.
    void adapter
      .runLogin({
        configDir: this.resolveConfigDir(input.configDir),
        timeoutMs: LOGIN_TIMEOUT_MS,
        onSpawn: (child, spawnInfo) => {
          run.child = child;
          this.processes.register(
            `auth:login:${id}`,
            childProcessHandle(child, spawnInfo),
          );
          // A SECOND listener on a stream the adapter is already reading. That is
          // safe (node fans out 'data') and it is the point of taking the child
          // here: the adapter owns the spawn, this service owns what the output
          // MEANS, and neither has to learn the other's job.
          child.stdout?.on('data', (chunk: Buffer | string) =>
            this.absorb(run, String(chunk)),
          );
          child.stderr?.on('data', (chunk: Buffer | string) =>
            this.absorb(run, String(chunk)),
          );
        },
      })
      .then((out) => this.settle(run, out !== null))
      .catch(() => this.settle(run, false));

    await this.waitForUrl(run);
    return run.session;
  }

  /**
   * Start a sign-in to ONE MCP server, without opening a terminal window.
   *
   * The same session shape, the same map and the same `status`/`cancel` routes
   * as the account sign-in above — this is a second flow through one machine
   * rather than a second machine, which is what stops the two drifting on
   * lifecycle. What is genuinely different is only how it is spawned (under a
   * pty; `AgentCommandOptions.pty` carries the probe) and how its verdict is
   * read (out of the CLI's words, since the exit status belongs to the pty
   * wrapper).
   *
   * The CLI opens the browser itself and serves its own localhost callback, so
   * geniro neither opens a tab nor holds the flow: `url` is here for the run
   * where the browser did not open, exactly as it is for the account login.
   */
  async startMcpLogin(input: {
    agent: AgentKind;
    server: string;
    /**
     * Omitted means the folder-independent directory the team editor's own
     * listing was taken in — see {@link mcpLoginQuerySchema}. Never "wherever
     * this process happens to be".
     */
    cwd?: string;
    configDir?: string;
  }): Promise<LoginSession> {
    const adapter = this.adapters.for(input.agent);
    const { loginArgs, loginUnavailableReason } = adapter.getConfig().mcp;
    if (loginArgs === null) {
      throw new BadRequestException(
        'MCP_LOGIN_UNSUPPORTED',
        loginUnavailableReason ??
          `${input.agent} cannot sign in to an MCP server`,
      );
    }
    const projectDir =
      input.cwd === undefined
        ? ensureFolderlessDir()
        : resolveValidCwd(input.cwd);
    const configDir = this.resolveConfigDir(input.configDir);
    const id = randomUUID();
    const run: LoginRun = {
      session: {
        id,
        agent: input.agent,
        status: 'waiting',
        url: null,
        message: null,
      },
      child: null,
      output: '',
      sinceCode: null,
      evictTimer: null,
      server: input.server,
      // Canonicalized ONCE and reused for both the child and the session
      // retirement below — the registry matches on the string a turn recorded,
      // which is the resolved one.
      cwd: projectDir,
      configDir,
    };
    this.runs.set(id, run);

    void adapter
      .runMcpLogin({
        server: input.server,
        // Validated here rather than trusted: this becomes a child's cwd, and
        // the CLI resolves the server name against it.
        cwd: projectDir,
        configDir,
        timeoutMs: LOGIN_TIMEOUT_MS,
        onSpawn: (child, spawnInfo) => {
          run.child = child;
          this.processes.register(
            `auth:login:${id}`,
            childProcessHandle(child, spawnInfo),
          );
          child.stdout?.on('data', (chunk: Buffer | string) =>
            this.absorb(run, String(chunk)),
          );
          child.stderr?.on('data', (chunk: Buffer | string) =>
            this.absorb(run, String(chunk)),
          );
        },
      })
      // `runMcpLogin` captures the output whatever the exit status, so a null
      // is the spawn itself having failed — the CLI never ran, which is not
      // the same as a sign-in that did not take.
      .then((out) => this.settle(run, out !== null))
      .catch(() => this.settle(run, false));

    await this.waitForUrl(run);
    return run.session;
  }

  /** Where a sign-in has got to. */
  status(id: string): LoginSession {
    return this.mustFind(id).session;
  }

  /**
   * Hand the CLI a code the user pasted.
   *
   * Refused unless the CLI has actually ASKED for one — writing to the stdin of a
   * process that is polling a browser would be swallowed silently, and the user
   * would be left believing they had answered something.
   */
  submitCode(id: string, code: string): LoginSession {
    const run = this.mustFind(id);
    if (run.session.status !== 'needs_code') {
      throw new BadRequestException(
        'CLI_LOGIN_NOT_AWAITING_CODE',
        `sign-in ${id} is not waiting for a code (it is ${run.session.status})`,
      );
    }
    const trimmed = code.trim();
    if (trimmed === '') {
      throw new BadRequestException(
        'CLI_LOGIN_EMPTY_CODE',
        'a sign-in code cannot be blank',
      );
    }
    const stdin = run.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new BadRequestException(
        'CLI_LOGIN_STDIN_CLOSED',
        `sign-in ${id} can no longer be written to`,
      );
    }
    stdin.write(`${trimmed}\n`);
    // Back to `waiting`: the code is in, and whether it was the RIGHT code is
    // the CLI's answer to give by exiting, not ours to assume by accepting it.
    run.session = { ...run.session, status: 'waiting', message: 'Signing in…' };
    // From here the prompt is judged on what the CLI says NEXT — see
    // `LoginRun.sinceCode`.
    run.sinceCode = '';
    return run.session;
  }

  /** Give up on a sign-in and reap its group. */
  cancelLogin(id: string): LoginSession {
    const run = this.mustFind(id);
    this.processes.cancel(`auth:login:${id}`);
    if (!isOver(run.session.status)) {
      run.session = { ...run.session, status: 'cancelled', message: null };
    }
    this.scheduleEviction(run);
    return run.session;
  }

  /**
   * Forget an ENDED sign-in once its verdict has had time to be read — see
   * {@link SETTLED_LOGIN_RETENTION_MS}. Idempotent: a cancel and the child's
   * own exit both end a run.
   */
  private scheduleEviction(run: LoginRun): void {
    if (run.evictTimer !== null) {
      return;
    }
    run.evictTimer = setTimeout(() => {
      this.runs.delete(run.session.id);
      // Nothing more is read from it, and the transcript is the one stream
      // here that can hold a one-time code.
      run.output = '';
      run.sinceCode = null;
    }, SETTLED_LOGIN_RETENTION_MS);
    // A forget nobody waits on must not hold the daemon open at shutdown.
    run.evictTimer.unref?.();
  }

  /**
   * Absorb a chunk of the CLI's output into what we know about the run.
   *
   * The output is accumulated because both things read from it are about the
   * output SO FAR — a URL printed before the first chunk boundary, and a prompt
   * that may arrive split across two reads — but only its TAIL
   * ({@link LOGIN_OUTPUT_TAIL_CHARS}): everything worth reading is recent, and a
   * whole-transcript buffer re-scanned per chunk made a chatty CLI quadratic.
   * It never leaves this process: only the extracted URL and one progress line
   * reach the wire.
   */
  private absorb(run: LoginRun, chunk: string): void {
    run.output = tailOf(run.output + chunk);
    if (run.sinceCode !== null) {
      run.sinceCode = tailOf(run.sinceCode + chunk);
    }
    if (isOver(run.session.status) || run.session.status === 'verifying') {
      return;
    }
    // Stripped from the buffer rather than per chunk, which is the only form
    // that is correct: a terminal escape can straddle a read boundary, and a
    // hyperlink cut in half would leave its own bytes in the text that the URL
    // match then runs through. Prose survives this unchanged, so both kinds of
    // child are read the same way.
    const text = plainTerminalText(run.output);
    const adapter = this.adapters.for(run.session.agent);
    // The pattern describes the CLI's own ACCOUNT sign-in; a server sign-in's
    // link is on that server's provider, whatever the CLI prints around it.
    const url =
      run.session.url ??
      firstUrlIn(
        text,
        run.server === null ? adapter.getConfig().auth.loginUrlPattern : null,
      );
    // Once a code is in, only what the CLI said SINCE can ask for another —
    // see `LoginRun.sinceCode`.
    const wantsCode = adapter.loginWantsCode(
      run.sinceCode === null ? text : plainTerminalText(run.sinceCode),
    );
    run.session = {
      ...run.session,
      url,
      // `needs_code` sticks until the code is submitted or the run ends; a later
      // chunk must not quietly drop it back to `waiting`, or a filled field
      // would vanish under the user mid-paste.
      status:
        wantsCode || run.session.status === 'needs_code'
          ? 'needs_code'
          : 'waiting',
      message:
        lastProgressLine(text, (line) => adapter.loginWantsCode(line)) ??
        run.session.message,
    };
  }

  /** The child exited (or the deadline reaped it). */
  private settle(run: LoginRun, ok: boolean): void {
    if (run.session.status === 'cancelled') {
      return;
    }
    const text = plainTerminalText(run.output);
    // A SERVER sign-in cannot be judged by an exit status: it runs under a pty
    // wrapper whose status is its own. The CLI's own words are the only verdict
    // there is, and a CLI that declares no failure wording leaves this false —
    // stated at `mcp.loginFailureMarkers`, along with why an invented marker
    // would be worse than none.
    const completed =
      ok &&
      !(
        run.server !== null &&
        this.adapters.for(run.session.agent).mcpLoginFailed(text)
      );
    if (completed && run.server !== null && run.cwd !== null) {
      // The CLI exiting is not the connector working: claude's claude.ai
      // connectors exit about a second after opening the browser, before the
      // user has authorized anything. Only an observed connect ends this.
      run.session = {
        ...run.session,
        status: 'verifying',
        message: `Finish signing in to ${run.server} in your browser — geniro is checking the connection.`,
      };
      this.verify(run, Date.now() + LOGIN_TIMEOUT_MS, 0, VERIFY_FIRST_DELAY_MS);
      return;
    }
    run.session = {
      ...run.session,
      status: completed ? 'succeeded' : 'failed',
      message: completed
        ? null
        : (lastProgressLine(text, (line) =>
            this.adapters.for(run.session.agent).loginWantsCode(line),
          ) ?? null),
    };
    if (completed && run.server === null) {
      this.accountChanged(run.session.agent, 'signed in to a new account');
    }
    if (!completed) {
      // Logged without the output, for the reason `lastProgressLine` exists: a
      // sign-in's stdout is the one stream here that can hold a one-time code.
      this.logger.warn(
        `${run.session.agent} sign-in did not complete (${run.session.id})`,
      );
    }
    this.scheduleEviction(run);
  }

  /**
   * Re-check a `verifying` server sign-in after `waitMs`, then after
   * `nextDelayMs` and longer, until the server is seen connected or `deadline`
   * passes.
   *
   * Through `AgentMcpService.recheckServerHealth`, so each dial also corrects
   * every cached reading of the server and clears a CLI's own needs-auth record. A
   * connect retires the kept sessions the sign-in reaches — the ones that
   * started without the server — and only then is the sign-in `succeeded`.
   */
  private verify(
    run: LoginRun,
    deadline: number,
    waitMs: number,
    nextDelayMs: number,
  ): void {
    // Not cleared on a cancel: `verifyOnce` checks the status first, and a
    // cancelled sign-in is no longer `verifying`.
    setTimeout(() => {
      void this.verifyOnce(run, deadline, nextDelayMs);
    }, waitMs).unref?.();
  }

  private async verifyOnce(
    run: LoginRun,
    deadline: number,
    nextDelayMs: number,
  ): Promise<void> {
    const { server, cwd, configDir } = run;
    if (run.session.status !== 'verifying' || server === null || cwd === null) {
      return;
    }
    const agent = run.session.agent;
    // The health-only re-check: one server dialled per tick, never the
    // folder's whole listing re-read behind it.
    const status = await this.mcp
      .recheckServerHealth(agent, cwd, server, { configDir })
      .then((health) => health?.status ?? null)
      .catch((err: unknown) => {
        this.logger.warn(
          `re-checking ${server} after its sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
    if (run.session.status !== 'verifying') {
      // Cancelled while the dial ran.
      return;
    }
    if (status === 'connected') {
      run.session = { ...run.session, status: 'succeeded', message: null };
      await this.mcp.retireSessionsReachedBy(
        agent,
        'signIn',
        cwd,
        configDir,
        `you signed in to ${server}`,
      );
      this.scheduleEviction(run);
      return;
    }
    if (Date.now() >= deadline) {
      run.session = {
        ...run.session,
        status: 'failed',
        message: `${server} still isn't connected. Finish signing in in your browser, then re-check it.`,
      };
      this.logger.warn(
        `${agent} sign-in to ${server} never connected (${run.session.id})`,
      );
      this.scheduleEviction(run);
      return;
    }
    this.verify(
      run,
      deadline,
      nextDelayMs,
      Math.min(nextDelayMs * VERIFY_BACKOFF, VERIFY_MAX_DELAY_MS),
    );
  }

  private async waitForUrl(run: LoginRun): Promise<void> {
    const deadline = Date.now() + URL_WAIT_MS;
    while (
      run.session.url === null &&
      !isOver(run.session.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, URL_POLL_MS));
    }
  }

  private mustFind(id: string): LoginRun {
    const run = this.runs.get(id);
    if (!run) {
      throw new NotFoundException('CLI_LOGIN_NOT_FOUND', `no sign-in: ${id}`);
    }
    return run;
  }

  /**
   * Validated when given, for the reason the handoff routes validate theirs: a
   * path that does not resolve must fail as a bad request rather than as a CLI
   * that silently starts a brand-new signed-out profile there (probe-verified —
   * claude CREATES whatever directory it is handed).
   */
  private resolveConfigDir(configDir: string | undefined): string | null {
    return configDir === undefined ? null : resolveValidConfigDir(configDir);
  }
}

/** Whether a status is one nothing further will change. */
function isOver(status: LoginStatus): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled'
  );
}

/** The last {@link LOGIN_OUTPUT_TAIL_CHARS} of a buffer. */
function tailOf(buffer: string): string {
  return buffer.length > LOGIN_OUTPUT_TAIL_CHARS
    ? buffer.slice(-LOGIN_OUTPUT_TAIL_CHARS)
    : buffer;
}
