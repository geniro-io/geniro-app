import type { GeniroApi } from '../shared/contracts';

declare global {
  interface Window {
    /** Privileged API exposed by the preload via contextBridge. */
    geniro: GeniroApi;
  }
}

export {};
