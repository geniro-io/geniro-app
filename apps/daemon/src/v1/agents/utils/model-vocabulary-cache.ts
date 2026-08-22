import type { AgentKind } from '../../runs/runs.types';

/**
 * The caching a per-(CLI, model) vocabulary listing needs, without any of the
 * vocabularies.
 *
 * Two services ask a CLI the same SHAPE of question — which reasoning-effort
 * levels does this model take, which context-window sizes does it offer — and
 * both answers cost a real handshake against the binary (~2s for cursor), both
 * go stale only when the CLI or the account changes, and both are asked by two
 * screens at once the moment a model is picked. Extracted rather than mirrored
 * (`.claude/rules/daemon-module-structure.md`): the second service copying
 * these thirty lines is how a single-flight fix comes to exist in one of them.
 *
 * Three rules it holds, each of which was a defect the effort listing hit
 * first:
 *
 * - **Keyed by the BINARY's version as well as the model.** A CLI upgraded
 *   under a running daemon answers differently, and a TTL alone would serve
 *   the old vocabulary for its remainder.
 * - **Single-flight, joined AFTER the freshness check** — so a warm answer
 *   still costs nothing, while a cold one asked by the composer and a graph
 *   inspector in the same instant spawns ONE process group rather than two.
 * - **A null model is its OWN key**, not a missing one: "what does this CLI
 *   offer at all" is a real question with a real answer, and folding it into
 *   the first model's entry would serve that model's list as the CLI's.
 */
export interface ModelVocabularyCacheOptions {
  /** How long an answer stays fresh. */
  ttlMs: number;
  /** Clock (test seam). */
  now: () => number;
}

export class ModelVocabularyCache<T> {
  private readonly entries = new Map<
    string,
    { version: string | null; fetchedAt: number; value: T }
  >();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly options: ModelVocabularyCacheOptions) {}

  /**
   * The cached answer, or the one `fetch` produces — asked at most once per
   * (kind, model) at a time.
   *
   * `fetch` receives whatever was cached before, so a listing that fails can
   * keep serving the last good answer instead of a dead picker. It must not
   * throw; a rejection is the caller's to model.
   */
  async read(
    kind: AgentKind,
    model: string | null,
    version: string | null,
    fetch: (previous: T | undefined) => Promise<T>,
  ): Promise<T> {
    const key = keyFor(kind, model);
    const cached = this.entries.get(key);
    if (
      cached &&
      cached.version === version &&
      this.options.now() - cached.fetchedAt < this.options.ttlMs
    ) {
      return cached.value;
    }
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const pending = fetch(cached?.value).then((value) => {
      this.entries.set(key, {
        version,
        fetchedAt: this.options.now(),
        value,
      });
      return value;
    });
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * The cached answer if it is still fresh, WITHOUT asking anything — the
   * synchronous read a request path can afford.
   *
   * The version is deliberately not consulted: resolving it spawns, and this
   * exists precisely so a caller need not. A CLI upgraded inside the TTL is the
   * one case that answers from the previous binary's vocabulary.
   */
  fresh(kind: AgentKind, model: string | null): T | undefined {
    const entry = this.entries.get(keyFor(kind, model));
    if (!entry || this.options.now() - entry.fetchedAt >= this.options.ttlMs) {
      return undefined;
    }
    return entry.value;
  }
}

/**
 * `(agent, model)` — a null model is its own key, not a missing one.
 *
 * Joined on a character no model id can contain, written as the ESCAPE and
 * never as the raw byte: a NUL inside a `.ts` file makes git classify the blob
 * as binary — no diff, no inline review, no three-way merge — and the repo's
 * own pre-commit hook refuses one for exactly that reason. The two are the
 * same code unit at runtime, so nothing about the key changes.
 */
function keyFor(kind: AgentKind, model: string | null): string {
  return `${kind}\u0000${model ?? ''}`;
}
