export const AGENT_STOP_SENTENCE =
  'The user pressed Stop in this tab — do not drive it again without asking.';

export const navigationNeedsApproval = (host: string): string =>
  `Navigation to ${host} needs the user's approval — call browser_navigate with that address`;

export interface AgentOpInit {
  memberName: string;
  /** Lower-case hosts the chat has approved, or null when every host is. */
  allowedHosts: readonly string[] | null;
  /** Hosts the daemon already vetted for this very operation. */
  vettedHosts?: readonly string[];
}

/**
 * One agent operation running on a tab: who drives it, which hosts a
 * navigation it causes may reach, and the Stop signal.
 */
export class AgentOp {
  readonly memberName: string;
  blockedHost: string | null = null;
  authBlocked = false;
  private readonly allowed: ReadonlySet<string> | null;
  private readonly controller = new AbortController();
  private onEnd: (() => void) | null = null;
  private ended = false;

  constructor(init: AgentOpInit) {
    this.memberName = init.memberName;
    this.allowed =
      init.allowedHosts === null
        ? null
        : new Set(
            [...init.allowedHosts, ...(init.vettedHosts ?? [])].map((host) =>
              host.toLowerCase(),
            ),
          );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    this.controller.abort();
  }

  bind(onEnd: () => void): void {
    this.onEnd = onEnd;
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.onEnd?.();
  }

  /** False, and remembers the host, when the navigation reaches one nobody approved. */
  permitsNavigation(url: string): boolean {
    if (this.allowed === null) {
      return true;
    }
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return true;
    }
    if (this.allowed.has(host)) {
      return true;
    }
    this.blockedHost = host;
    return false;
  }
}
