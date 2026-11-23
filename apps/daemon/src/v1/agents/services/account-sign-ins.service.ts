import { Injectable } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';

/** Told of a completed account sign-in: the CLI and the profile it signed in. */
export type AccountSignInListener = (
  agent: AgentKind,
  configDir: string | null,
) => void;

/**
 * Account sign-ins geniro ran itself, for whatever keeps a verdict on an
 * account's login — the one account change the daemon can observe.
 */
@Injectable()
export class AccountSignIns {
  private readonly listeners = new Set<AccountSignInListener>();

  onSignedIn(listener: AccountSignInListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  signedIn(agent: AgentKind, configDir: string | null): void {
    for (const listener of this.listeners) {
      listener(agent, configDir);
    }
  }
}
