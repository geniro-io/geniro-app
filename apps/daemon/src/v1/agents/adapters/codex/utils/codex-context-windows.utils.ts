import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type { AgentContextWindowListing } from '../../adapter.types';

/** One model's windows as codex's own catalog states them. */
export interface CodexModelWindows {
  /** What a thread runs at with no override. */
  defaultTokens: number;
  /** The most `model_context_window` can raise it to; codex clamps above. */
  maxTokens: number;
}

/**
 * One model's windows out of a parsed `models_cache.json`, or null when the
 * catalog does not list it with both figures.
 */
export function readCodexModelWindows(
  catalog: unknown,
  model: string,
): CodexModelWindows | null {
  for (const entry of asArray(asRecord(catalog)?.models)) {
    const record = asRecord(entry);
    if (record === null || asString(record.slug) !== model) {
      continue;
    }
    const defaultTokens = asNumber(record.context_window);
    const maxTokens = asNumber(record.max_context_window);
    if (
      defaultTokens === null ||
      maxTokens === null ||
      defaultTokens <= 0 ||
      maxTokens <= 0
    ) {
      return null;
    }
    return { defaultTokens, maxTokens: Math.max(defaultTokens, maxTokens) };
  }
  return null;
}

/**
 * A window as the picker names it — `272k`, `1m` — which is also the value
 * stored on a run and parsed back by {@link codexWindowTokens}.
 */
export function codexWindowLabel(tokens: number): string {
  if (tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}m`;
  }
  if (tokens % 1_000 === 0) {
    return `${tokens / 1_000}k`;
  }
  return String(tokens);
}

/**
 * The token count a stored window names, or null for one this reader cannot
 * place. Accepts the `k`/`m` spelling {@link codexWindowLabel} writes and a
 * bare count, so a value from a hand-edited workflow still reaches the flag.
 */
export function codexWindowTokens(
  window: string | null | undefined,
): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(window ?? '');
  if (match === null) {
    return null;
  }
  const scale =
    match[2]!.toLowerCase() === 'm'
      ? 1_000_000
      : match[2]!.toLowerCase() === 'k'
        ? 1_000
        : 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/** The picker's listing for one model, from its catalog windows. */
export function codexContextWindowListing(
  model: string | null,
  windows: CodexModelWindows | null,
): AgentContextWindowListing {
  if (model === null || model.trim() === '') {
    return {
      windows: [],
      unavailableReason:
        'pick a model to see the context-window sizes it offers',
      unavailableKind: 'no-model',
      exact: false,
    };
  }
  if (windows === null) {
    return {
      windows: [],
      unavailableReason:
        "codex's model catalog states no window sizes for this model",
      unavailableKind: 'unreadable',
      exact: false,
    };
  }
  if (windows.maxTokens <= windows.defaultTokens) {
    return {
      windows: [],
      unavailableReason: `codex runs this model at its one window, ${codexWindowLabel(windows.defaultTokens)}`,
      unavailableKind: 'fixed-window',
      exact: true,
    };
  }
  return {
    windows: [windows.defaultTokens, windows.maxTokens].map((tokens) => ({
      id: codexWindowLabel(tokens),
      label: codexWindowLabel(tokens),
    })),
    unavailableReason: null,
    unavailableKind: null,
    exact: true,
  };
}
