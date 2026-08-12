import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { childProcessHandle } from '../../agents/utils/child-handle';
import { resolveValidConfigDir } from '../../agents/utils/resolve-config-dir';
import type { AgentKind } from '../../runs/runs.types';
import type { LoginSession, LoginStatus, LogoutResult } from '../auth.types';
import { LOGIN_TIMEOUT_MS } from '../auth.types';
import { firstUrlIn, lastProgressLine } from '../utils/login-output';

/** How long `start` waits for the CLI to print its URL before answering anyway. */
const URL_WAIT_MS = 4_000;
/** Poll interval while waiting for the URL — short, since this blocks a request. */
const URL_POLL_MS = 100;
/** A sign-out clears a file and exits; it has no reason to take longer. */
const LOGOUT_TIMEOUT_MS = 20_000;

/** One tracked sign-in: its public state plus the child we are watching. */
interface LoginRun {
  session: LoginSession;
  child: ChildProcess | null;
  output: string;
}

/**
 * Signs a CLI in and out WITHOUT opening a terminal window.
 *
 * The sibling of `HandoffService`'s `loginTarget`/`logoutTarget`, and deliberately
 * not a replacement for them: that pair RESOLVES an invocation for the user's own
 * terminal and stays the fallback here — for a CLI this cannot drive, for a flow
 * that stalls, and for anyone who would rather watch it happen. This service is
 * what makes the ordinary case windowless.
 *
 * Why the daemon may run these at all, when `AdapterConfig.auth.loginArgs` says
 * it resolves and never runs: that instruction generalised a probe of `mcp
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
  ) {}

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
    return run.session;
  }

  /** Give up on a sign-in and reap its group. */
  cancelLogin(id: string): LoginSession {
    const run = this.mustFind(id);
    this.processes.cancel(`auth:login:${id}`);
    if (!isOver(run.session.status)) {
      run.session = { ...run.session, status: 'cancelled', message: null };
    }
    return run.session;
  }

  /**
   * Absorb a chunk of the CLI's output into what we know about the run.
   *
   * The whole transcript is accumulated because both things read from it are
   * about the output SO FAR — a URL printed before the first chunk boundary, and
   * a prompt that may arrive split across two reads. It never leaves this
   * process: only the extracted URL and one progress line reach the wire.
   */
  private absorb(run: LoginRun, chunk: string): void {
    run.output += chunk;
    if (isOver(run.session.status)) {
      return;
    }
    const url = run.session.url ?? firstUrlIn(run.output);
    const wantsCode = this.adapters
      .for(run.session.agent)
      .loginWantsCode(run.output);
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
      message: lastProgressLine(run.output) ?? run.session.message,
    };
  }

  /** The child exited (or the deadline reaped it). */
  private settle(run: LoginRun, ok: boolean): void {
    if (run.session.status === 'cancelled') {
      return;
    }
    run.session = {
      ...run.session,
      status: ok ? 'succeeded' : 'failed',
      message: ok ? null : (lastProgressLine(run.output) ?? null),
    };
    if (!ok) {
      // Logged without the output, for the reason `lastProgressLine` exists: a
      // sign-in's stdout is the one stream here that can hold a one-time code.
      this.logger.warn(
        `${run.session.agent} sign-in did not complete (${run.session.id})`,
      );
    }
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
