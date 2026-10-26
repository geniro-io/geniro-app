import type { ActionStopService } from '../services/action-stop.service';

/**
 * A stop service for specs that publish and press message actions only: any
 * use of it fails the spec.
 */
export const NO_STOPS = {
  resolve: () =>
    Promise.reject(new Error('this spec publishes no stop action')),
  stop: () => Promise.reject(new Error('this spec presses no stop action')),
} as unknown as ActionStopService;
