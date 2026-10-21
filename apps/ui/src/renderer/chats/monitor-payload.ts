const EVENTS = ['start', 'batch', 'end'] as const;
const END_KINDS = [
  'exit',
  'signal',
  'timeout',
  'stopped',
  'flooded',
  'interrupted',
] as const;

export type MonitorEvent = (typeof EVENTS)[number];

/** How a monitor's command ended; `code` is set for `exit`, `signal` for `signal`. */
export interface MonitorEnd {
  kind: (typeof END_KINDS)[number];
  code?: number;
  signal?: string;
}

/** One monitor's part in a notice. */
export interface MonitorEntry {
  /** The id the agent knows it by, `m1`. */
  id: string;
  description: string;
  event: MonitorEvent;
  end: MonitorEnd | null;
  /** The output delivered with this notice. */
  lines: string[];
  /** Lines that were cut before delivery. */
  omitted: number;
}

export interface MonitorNotice {
  /** Whether the notice started a turn of the agent's own. */
  woke: boolean;
  monitors: MonitorEntry[];
}

function isOneOf<T extends string>(
  options: readonly T[],
  value: unknown,
): value is T {
  return options.some((option) => option === value);
}

function readEnd(value: unknown): MonitorEnd | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { kind, code, signal } = value as Record<string, unknown>;
  if (!isOneOf(END_KINDS, kind)) {
    return undefined;
  }
  const end: MonitorEnd = { kind };
  if (typeof code === 'number' && Number.isFinite(code)) {
    end.code = code;
  }
  if (typeof signal === 'string' && signal !== '') {
    end.signal = signal;
  }
  return end;
}

function readEntry(value: unknown): MonitorEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { id, description, event, end, lines, omitted } = value as Record<
    string,
    unknown
  >;
  const readEnding = readEnd(end);
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof description !== 'string' ||
    !isOneOf(EVENTS, event) ||
    readEnding === undefined ||
    !Array.isArray(lines) ||
    !lines.every((line) => typeof line === 'string') ||
    typeof omitted !== 'number' ||
    !Number.isInteger(omitted) ||
    omitted < 0
  ) {
    return null;
  }
  return {
    id,
    description,
    event,
    end: readEnding,
    lines: lines as string[],
    omitted,
  };
}

/**
 * The monitors a notice row is about, or null when the row is not one.
 *
 * A monitor's output arrives in batches, each a system row; one that woke the
 * agent says so, so the transcript can draw the agent picking the work back up.
 *
 * TWIN PARSER: written by `monitorRowPayload` in
 * `apps/daemon/src/v1/agents/utils/monitor-text.ts`; its shape is
 * `MonitorRowPayload` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export function readMonitorNotice(payload: unknown): MonitorNotice | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const { monitors, woke } = payload as { monitors?: unknown; woke?: unknown };
  if (!Array.isArray(monitors)) {
    return null;
  }
  const entries = monitors.flatMap((value) => {
    const entry = readEntry(value);
    return entry === null ? [] : [entry];
  });
  return entries.length === 0
    ? null
    : { woke: woke === true, monitors: entries };
}
