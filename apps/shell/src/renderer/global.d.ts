import type { GeniroApi } from '@packages/types';

declare global {
  interface Window {
    /** Privileged API exposed by the preload via contextBridge. */
    geniro: GeniroApi;
  }
}

export {};
