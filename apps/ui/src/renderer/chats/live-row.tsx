import { createContext, useContext, useEffect, useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { formatTokens } from './agent-activity';
import { MessageBubble } from './message-bubble';
import type { RunSettleAt } from './transcript-groups';

/**
 * What the active run is doing right now — the daemon's own `run_status`
 * activity, the same sentence the sidebar badge carries.
 *
 * A context rather than a prop, for the reason `AttachmentLoaderContext` is
 * one: the shells between `Chats` and this row are memoized on referentially
 * stable props, and threading a string that changes mid-turn through every one
 * of them would defeat that memoization. Null outside a provider, and null
 * while the daemon has not said — the row then names the state alone.
 */
export const RunActivityContext = createContext<string | null>(null);

/**
 * Whether the active run has reached a terminal status — nothing more is
 * coming for it.
 *
 * The transcript alone cannot answer this, and that gap is the bug it exists to
 * close: a tool row spins while its `tool_result` is missing, and a result the
 * daemon dropped between turns never arrives, so a run whose header read
 * `completed` kept a sub-agent row spinning indefinitely. Authoritative run
 * state is the only thing that can retire it — the same rule the live rows
 * already follow.
 *
 * A context for the reason {@link RunActivityContext} is one: the shells
 * between `Chats` and a tool group are memoized, and a prop that flips once at
 * the end of a run would defeat that for every row. Null outside a provider,
 * which is the safe reading — a group with no run behind it keeps whatever its
 * own pairs say.
 *
 * It carries WHEN the run settled ({@link RunSettleAt}) rather than merely THAT
 * it did, because a reader has to be able to ask whether a given piece of
 * nested work has spoken SINCE. A delegate producing rows after the run row went `completed`
 * is still working, however plainly that row says otherwise, and a bare boolean
 * could not express the difference: it painted every unreturned delegate in the
 * chat `stopped` at once. Measured on the author's own `geniro.db` — run
 * `f42bfe2d` took 1346 further delegate rows after the item that settled it.
 * A reader that only needs the fact asks `!== null`.
 */
export const RunSettledContext = createContext<RunSettleAt>(null);

/**
 * The two synthetic transcript rows that describe what an agent is doing RIGHT
 * NOW: a reasoning stretch, and the silence between one thing and the next.
 *
 * They own their own clock rather than being handed an elapsed number, and that
 * is the whole reason they are components at all. The elapsed time used to be
 * computed inside the transcript fold, from `Date.now()` at render — so it only
 * advanced when a delta happened to arrive, which is why the counter visibly
 * jumped (30s → 34s) instead of counting seconds. A row that ticks itself
 * advances every second, and re-renders nothing but itself.
 */

/**
 * Marks a synthetic transcript row as one of the two LIVE-state rows rather
 * than words on their way to becoming durable.
 *
 * Both ride the `reasoning` item kind — already styled as the muted aside they
 * are — and this field is what tells them apart at the render site, so neither
 * needed a new entry type threading through every switch of the fold. The
 * numbers ride raw for the same reason the rows tick themselves: an elapsed
 * time baked into the fold only advances when a delta happens to arrive.
 *
 * It lives HERE rather than beside the fold that writes it so the writer and
 * the reader can both depend on it without depending on each other.
 */
export type LiveRowKind = 'thinking' | 'working';

/** Read the live-row marker off a synthetic item's payload, or null. */
export function liveRowKind(payload: unknown): LiveRowKind | null {
  if (payload && typeof payload === 'object' && 'live' in payload) {
    const value = (payload as { live: unknown }).live;
    if (value === 'thinking' || value === 'working') {
      return value;
    }
  }
  return null;
}

/** Re-render once a second, so an elapsed readout counts real seconds. */
function useSecondsTick(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
}

/**
 * `12s`, `1m 5s`, `2h 8m 57s` — the elapsed form both rows read.
 *
 * The hours tier is the whole of a report, and the header is where it showed:
 * `worked 128m 57s / 14 turns`. Minutes were unbounded, so a thread's summed
 * working time — and a long thinking stretch, and a delegate's `took` — kept
 * counting past the point where anyone reads a minute count as a duration.
 * Nobody divides 128 by 60 to find out they have spent two hours.
 *
 * `stats/stats-format.ts` has had an hours-aware `formatDuration` since the
 * Stats page shipped, which is what made this one's absence a genuine
 * inconsistency rather than a missing feature: the same span read `2h 8m` on
 * one screen and `128m 57s` on another. The two do NOT merge, and the reason is
 * their precision: that one rounds to whole minutes, for totals nobody reads to
 * the second, while this one drives a clock that reticks every second and would
 * visibly freeze without them.
 *
 * There is deliberately no DAY tier. Hours stay unbounded, so a thread that
 * worked a full day reads `25h 3m 40s` — long, legible, and one unit rather
 * than a fourth case nothing in the app has yet produced.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

/**
 * One reasoning stretch: how much thinking it has cost, and for how long.
 *
 * Both numbers are per STRETCH. A turn that thinks, runs tools, then thinks
 * again is two separate waits, and each gets its own row — the daemon's
 * stretch id is what keys them apart, so a new stretch mounts a fresh
 * component with a clock starting at zero.
 */
export function ThinkingRow({
  since,
  tokens,
}: {
  /** Epoch ms this stretch began. */
  since: number;
  /** Reasoning tokens spent in this stretch so far. */
  tokens: number;
}): React.JSX.Element {
  useSecondsTick();
  return (
    <LiveRow
      label={`Thinking… ${formatTokens(tokens)} tokens · ${formatElapsed(Date.now() - since)}`}
    />
  );
}

/**
 * The agent is working but has nothing to show for it yet — between a tool
 * batch finishing and the next words or reasoning delta arriving.
 *
 * Without this the transcript went silent for those stretches and the only
 * signal left was the status in the chat header, which is not where the user is
 * looking.
 *
 * It NAMES what the agent is doing whenever the daemon has said. "Working…"
 * and an elapsed clock describe a state without describing the work, which is
 * the complaint this answers: an abstract label leaves the user unable to tell
 * a long compaction from a hung tool. The clock stays either way — it is the
 * half of the row the daemon cannot supply.
 *
 * {@link since} is read out of the TRANSCRIPT (the last row this agent put on
 * screen), not from this component's mount. The clock used to start at mount, on
 * the reasoning that "how long this has been quiet" needs no state threaded
 * through the fold — true of the number, false of the ANSWER: every remount
 * restarted it, so switching to another chat and back reported a four-minute
 * wait as one second. Same defect, and the same fix, as the header's own clock
 * (`ChatHeader`'s `turnStartedAt`), which is why both now take a timestamp their
 * caller derived from durable rows. Mount time remains the fallback for an agent
 * with no durable row yet, where it is the only anchor there is and is right.
 */
export function WorkingRow({
  since = null,
}: {
  /** Epoch ms this agent last showed something, or null if it never has. */
  since?: number | null;
}): React.JSX.Element {
  const [mountedAt] = useState(() => Date.now());
  const activity = useContext(RunActivityContext);
  useSecondsTick();
  const elapsed = formatElapsed(Date.now() - (since ?? mountedAt));
  return (
    <LiveRow
      label={
        activity === null ? `Working… ${elapsed}` : `${activity} · ${elapsed}`
      }
    />
  );
}

/**
 * The shell both rows share — bubble, spinner, label. Split out so a change to
 * the chrome cannot land on one live row and not the other.
 *
 * It wears the `note` variant — the transcript's SYSTEM row: centred, small and
 * quiet. Neither row is the agent speaking; both are geniro narrating the state
 * of a turn, which is exactly what every other `note` row does, and the
 * left-aligned filled bubble they used to wear read as a message with content
 * (it sat in the assistant's column, at the assistant's weight, saying nothing
 * the conversation contains). The spinner is what a `note` alone cannot say:
 * this line is about work still running, so it will change.
 *
 * Deliberately WITHOUT `MessageBubble`'s `role` caption. These two rows are the
 * only ones whose body already names the state they are in, so the caption
 * printed the word a second time — a row reading "THINKING" over
 * "Thinking… 250 tokens · 12s". Every other bubble needs the caption because
 * its body is the agent's own words and says nothing about what kind of row it
 * is.
 */
function LiveRow({ label }: { label: string }): React.JSX.Element {
  return (
    <MessageBubble variant="note">
      {/* No italic: the row it must look like is the plain note beside it
          ("✓ done · $1.3306"), and an italic of its own made it a different
          kind of thing. The spinner is the only difference the state earns. */}
      <div className="flex items-center gap-1.5">
        <Spinner />
        <span>{label}</span>
      </div>
    </MessageBubble>
  );
}
