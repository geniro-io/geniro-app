import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import {
  firstUrlIn,
  lastProgressLine,
  plainTerminalText,
} from '../../auth/utils/login-output';
import { redactSecrets } from '../../diagnostics/utils/redact';
import {
  SHARE_COMMAND_RUNNER,
  SHARE_SIGN_IN_TIMEOUT_MS,
  type ShareCommandRunner,
  type ShareSignInSession,
  type ShareSignInStatus,
} from '../shares.types';
import { authProfileOf } from '../utils/share-auth';
import { ShareService } from './share.service';

/** How long a start waits for the CLI to print its link before answering. */
const URL_WAIT_MS = 4_000;
const URL_POLL_MS = 100;
/** How long a finished session stays readable, so a poll sees how it ended. */
const FINISHED_KEPT_MS = 10 * 60_000;
const MAX_LINES = 10;
const MAX_LINE_CHARS = 300;

interface SignInRun {
  session: ShareSignInSession;
  abort: AbortController;
  output: string;
  cancelled: boolean;
}

/**
 * Signs a share destination's CLI in again — `gcloud auth login`, `aws sso
 * login`, or a custom destination's own login argv — on the user's press,
 * then tries every share waiting on it once more.
 *
 * One session per destination: a second start while one runs joins it. The
 * CLI opens the browser itself (gcloud and aws both do with no terminal) and
 * serves its own redirect; the session carries the link it printed as a
 * fallback. A Cancel or the {@link SHARE_SIGN_IN_TIMEOUT_MS} deadline ends it
 * with nothing retried; a clean exit is confirmed by the destination's check
 * before {@link ShareService.retryAwaiting} runs — once per sign-in.
 */
@Injectable()
export class ShareSignInService {
  private readonly logger = new Logger(ShareSignInService.name);
  private readonly runs = new Map<string, SignInRun>();

  constructor(
    private readonly shares: ShareService,
    @Inject(SHARE_COMMAND_RUNNER) private readonly run: ShareCommandRunner,
  ) {}

  async start(destinationId: string): Promise<ShareSignInSession> {
    const destination = this.shares.destination(destinationId);
    if (destination === null) {
      throw new NotFoundException(
        'SHARE_DESTINATION_UNKNOWN',
        'that place to share to is not in Settings → Sharing',
      );
    }
    const profile = authProfileOf(destination);
    if (profile === null) {
      throw new BadRequestException(
        'SHARE_SIGN_IN_NOT_SET_UP',
        `${destination.name} has no sign-in command — add one in Settings → Sharing`,
      );
    }
    const running = [...this.runs.values()].find(
      (run) =>
        run.session.destinationId === destinationId &&
        !isOver(run.session.status),
    );
    if (running !== undefined) {
      return running.session;
    }
    const run: SignInRun = {
      session: {
        id: randomUUID(),
        destinationId,
        label: profile.label,
        cli: profile.cli,
        status: 'waiting',
        lines: [],
        url: null,
        message: null,
        retried: [],
      },
      abort: new AbortController(),
      output: '',
      cancelled: false,
    };
    this.runs.set(run.session.id, run);
    // Not awaited: the sign-in outlives this request; its end settles the session.
    void this.run({
      ...profile.login,
      label: 'share:login',
      timeoutMs: SHARE_SIGN_IN_TIMEOUT_MS,
      signal: run.abort.signal,
      onOutput: (line) => this.absorb(run, line),
    })
      .then(async (result) => {
        if (run.cancelled) {
          this.finish(run, 'cancelled', 'Sign-in cancelled.');
          return;
        }
        if (result.timedOut) {
          this.finish(run, 'timed-out', 'Sign-in timed out.');
          return;
        }
        if (result.code !== 0) {
          this.finish(
            run,
            'failed',
            result.spawnError !== undefined
              ? `${profile.cli} could not be started (${result.spawnError}) — is it installed?`
              : (lastProgressLine(
                  redactSecrets(plainTerminalText(run.output)),
                  // A line introducing a link (shown as `url`) says nothing.
                  (line) => line.endsWith(':'),
                ) ??
                  `${profile.cli} exited with status ${String(result.code)}`),
          );
          return;
        }
        await this.verifyAndRetry(run);
      })
      .catch((err: unknown) => {
        this.finish(run, 'failed', String(err));
      });
    await this.waitForUrl(run);
    return run.session;
  }

  status(id: string): ShareSignInSession {
    return this.mustFind(id).session;
  }

  cancel(id: string): ShareSignInSession {
    const run = this.mustFind(id);
    if (!isOver(run.session.status) && run.session.status !== 'verifying') {
      run.cancelled = true;
      run.abort.abort();
    }
    return run.session;
  }

  /** The sign-in exited cleanly: confirm it, then try the waiting shares once. */
  private async verifyAndRetry(run: SignInRun): Promise<void> {
    run.session = { ...run.session, status: 'verifying' };
    const destination = this.shares.destination(run.session.destinationId);
    if (destination === null) {
      this.finish(
        run,
        'failed',
        'That place was removed from Settings → Sharing.',
      );
      return;
    }
    const checked = await this.shares.check(destination);
    if (checked.state === 'sign-in-required') {
      this.finish(
        run,
        'failed',
        `Still signed out${checked.detail === undefined ? '' : `: ${checked.detail}`}`,
      );
      return;
    }
    const retried = await this.shares
      .retryAwaiting(run.session.destinationId)
      .catch((err: unknown) => {
        this.logger.warn(
          `retrying shares after sign-in to ${run.session.destinationId} failed: ${String(err)}`,
        );
        return [];
      });
    run.session = { ...run.session, retried };
    this.finish(run, 'succeeded', null);
  }

  private absorb(run: SignInRun, line: string): void {
    if (isOver(run.session.status)) {
      return;
    }
    run.output = `${run.output}${line}\n`.slice(-16_384);
    // Masks geniro's own registered secrets only; a token a custom login
    // command mints and prints is unknown here and is shown as printed.
    const text = redactSecrets(plainTerminalText(line)).trim();
    const url = run.session.url ?? firstUrlIn(text);
    const hasLink = /https?:\/\//.test(text);
    // A link line is shown as `url`; the line that only introduced it
    // ("…opened to visit:") would be left pointing at nothing.
    const kept =
      hasLink && run.session.lines.at(-1)?.endsWith(':') === true
        ? run.session.lines.slice(0, -1)
        : run.session.lines;
    const lines =
      text.length === 0 || hasLink
        ? kept
        : [...kept, text.slice(0, MAX_LINE_CHARS)].slice(-MAX_LINES);
    run.session = { ...run.session, url, lines };
  }

  private finish(
    run: SignInRun,
    status: ShareSignInStatus,
    message: string | null,
  ): void {
    run.session = { ...run.session, status, message };
    const evict = setTimeout(() => {
      this.runs.delete(run.session.id);
    }, FINISHED_KEPT_MS);
    evict.unref();
  }

  private async waitForUrl(run: SignInRun): Promise<void> {
    const deadline = Date.now() + URL_WAIT_MS;
    while (
      run.session.url === null &&
      !isOver(run.session.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, URL_POLL_MS));
    }
  }

  private mustFind(id: string): SignInRun {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new NotFoundException(
        'SHARE_SIGN_IN_NOT_FOUND',
        `no sign-in: ${id}`,
      );
    }
    return run;
  }
}

function isOver(status: ShareSignInStatus): boolean {
  return status !== 'waiting' && status !== 'verifying';
}
