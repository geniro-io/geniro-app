import {
  contextWindowKey,
  type ContextWindowStore,
} from '../context-window.store';

/**
 * An in-memory {@link ContextWindowStore} for specs.
 *
 * The real store's only side effect is a file under `<userData>`, and a unit
 * test that exercises the live plane has no business writing one. Everything
 * else about it — that a miss reads null, that a write is visible to the next
 * read — is preserved, so a spec asserting on seeding behaviour is asserting on
 * the real contract rather than on a mock's convenience.
 */
export class FakeContextWindowStore {
  /** Every (agent, model) window written, in call order — for assertions. */
  readonly writes: { agent: string; model: string; window: number }[] = [];
  private readonly records = new Map<string, number>();

  constructor(seed: Record<string, number> = {}) {
    for (const [key, window] of Object.entries(seed)) {
      this.records.set(key, window);
    }
  }

  get(agent: string, model: string): number | null {
    return this.records.get(contextWindowKey(agent, model)) ?? null;
  }

  remember(agent: string, model: string, window: number): void {
    // Deliberately WITHOUT the real store's reject guard. `writes` exists to
    // record what the live plane ASKED for; re-implementing the rejection here
    // would hide a caller that hands the store a zero, and the rejection
    // itself belongs to the real store's own spec.
    this.writes.push({ agent, model, window });
    this.records.set(contextWindowKey(agent, model), window);
  }

  /** The seed key shape, so a spec never spells the separator itself. */
  static key(agent: string, model: string): string {
    return contextWindowKey(agent, model);
  }

  /** Typed as the real store for constructor injection. */
  asStore(): ContextWindowStore {
    return this as unknown as ContextWindowStore;
  }
}
