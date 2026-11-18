import { DaemonConfigPush } from './daemon-config-push';

/** The body of `PUT /v1/command-center/instructions`. */
export interface CommandCenterInstructions {
  instructions: string;
}

/**
 * Hands the daemon the command center manager's standing instructions
 * (`Settings.commandCenterInstructions`, `PUT /v1/command-center/instructions`)
 * — see {@link DaemonConfigPush}. Until the first push lands the daemon's brief
 * carries no user instructions.
 *
 * TWIN PARSER: `CommandCenterInstructionsConfigSchema` in `apps/daemon/src/v1/command-center/command-center.types.ts`.
 */
export class CommandCenterInstructionsPush extends DaemonConfigPush<CommandCenterInstructions> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/command-center/instructions',
        what: 'the command center instructions',
        untilSaved:
          'the daemon keeps its previous instructions until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
