import type { ActionCommandService } from '../services/action-command.service';

/**
 * A command service for specs that publish and press message or stop actions
 * only: any use of it fails the spec.
 */
export const NO_COMMANDS = {
  resolveCwd: () =>
    Promise.reject(new Error('this spec publishes no command action')),
  run: () => Promise.reject(new Error('this spec presses no command action')),
} as unknown as ActionCommandService;
