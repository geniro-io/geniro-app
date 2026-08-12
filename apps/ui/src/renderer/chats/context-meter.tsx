import { useCallback, useRef, useState } from 'react';

import { Popover } from '../components/ui/popover';
import { ProgressRing } from '../components/ui/progress-ring';
import { cn } from '../components/ui/utils';
import { formatTokens, formatUsd } from './agent-activity';

/**
 * Fraction above which the ring warns, then alarms. Below `WARN_AT` it is
 * GREEN — a traffic light, not a brand accent: the ring exists to say how much
 * room is left, and `text-primary` (the app's caramel) reads as decoration
 * beside every other primary-toned control rather than as "you are fine".
 */
const WARN_AT = 0.6;
const ALARM_AT = 0.9;

/**
 * A ring with a readout behind it: the shell BOTH ring branches are drawn on —
 * the one showing how full the window is, and the one saying the CLI never
 * reports it.
 *
 * Extracted rather than copied, and it owns the open state because that is the
 * fiddly part: the pin/hover pair below took two attempts to get right, and a
 * second copy of it would be a second chance to get it wrong. The `data-slot`
 * is the same either way, so "where is the meter" stays one query whichever
 * shape it has taken.
 */
function MeterReadout({
  ring,
  label,
  side,
  className,
  children,
}: {
  ring: React.ReactNode;
  /** The whole reading, as the button's accessible name. */
  label: string;
  side: 'top' | 'bottom';
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setPinned(false);
    setHovered(false);
  }, []);
  return (
    <span
      data-slot="context-meter"
      className={cn('relative flex items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={pinned || hovered}
        // The ring is the whole control, so the button carries the reading as
        // its accessible name — a screen reader gets it without having to open
        // anything, which a hover-only readout could never provide.
        aria-label={label}
        // `size-full justify-center` so a caller can give the OUTER span a box
        // and have the ring centre in it. The agents panel does, because the row
        // it sits in is a strip of `size-6` icon buttons at `gap-0.5`: a bare
        // 14px ring in that row is 5px closer to its neighbour than the
        // neighbours are to each other, since their glyphs carry that padding
        // inside the button and the ring carried none. Equal BOXES is what makes
        // the gaps equal — a nudge margin would have to be re-tuned the moment
        // either size changes.
        className="flex size-full items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onBlur={() => setHovered(false)}
        // A press on an UNPINNED panel pins it; a press on a pinned one closes
        // it, clearing the hover term too.
        //
        // Both halves matter. A pointer never presses a control it has not
        // first entered, so the first press always arrives with `hovered`
        // already true — treating it as a toggle of `pinned` alone would close
        // what the user was reaching for. And on the way back out, unpinning
        // without clearing `hovered` leaves `pinned || hovered` true, so the
        // press the user reads as "close this" does nothing until the pointer
        // wanders off. A jsdom `.click()` neither hovers nor focuses, which is
        // why the first spec written here missed both.
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setHovered(false);
            return;
          }
          setPinned(true);
        }}
        onFocus={() => setHovered(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>
        {ring}
      </button>
      <Popover
        open={pinned || hovered}
        onClose={close}
        triggerRef={triggerRef}
        side={side}
        align="end"
        // Both call sites sit inside a clipping ancestor — the agents panel's
        // scrolling thread list, and the composer inside the shell's
        // `overflow-hidden` main — so an ancestor-positioned panel is CUT. It
        // was: the meter's own readout is the only place a sighted user gets the
        // figures at all, and the unavailable sentence rendered with its first
        // two thirds off-surface.
        anchor="viewport"
        label="Context usage"
        // `w-max` so the figures keep their one-line shape, `max-w` so a
        // sentence wraps instead of running off the screen.
        className="w-max max-w-[20rem] px-2.5 py-2">
        {children}
      </Popover>
    </span>
  );
}

/**
 * How full one agent's context window is, plus what the run has cost.
 *
 * EXTRACTED from the agents panel rather than written fresh: the panel already
 * rendered exactly this, and the header needed the same thing. One component
 * serving both is what makes them structurally incapable of disagreeing — the
 * defect was a header with no readout at all beside a panel that had one.
 *
 * The figures are DELIBERATELY not on screen while the window is known. A
 * header carrying `ctx 91.6k / 1M · 9%` next to a ring says the same thing
 * three times and crowds the row it sits in; the ring alone answers the only
 * question asked at a glance ("how much room is left"), and the numbers are one
 * hover — or one click, which pins the panel for a keyboard user — away.
 *
 * Renders nothing when there is nothing to say, so callers can place it
 * unconditionally.
 */
export function ContextMeter({
  contextTokens,
  contextWindowTokens,
  spentUsd = null,
  unavailableReason = null,
  side = 'bottom',
  className,
}: {
  /** Prompt-side tokens of the latest request, or null when unknown. */
  contextTokens: number | null;
  /** The model's own window, or null when the CLI has not reported one. */
  contextWindowTokens: number | null;
  /** Total spend across the run's turns, or null to omit. */
  spentUsd?: number | null;
  /**
   * Why this CLI never reports usage, from the daemon's own per-adapter report —
   * or null when it does report it.
   *
   * It exists because "no figures" has two causes that look identical and mean
   * opposite things: a turn that has not produced any yet, and a CLI that never
   * will. With no figures and no reason the meter renders nothing, which is
   * right for the first case and is how the second was reported — a user
   * pointing at the empty spot on a cursor card and asking why there is no
   * context there.
   */
  unavailableReason?: string | null;
  /**
   * Which way the readout opens. `Popover` does no collision detection — its
   * placement is two static ternaries — so a caller near an edge has to say.
   *
   * The ring shows no figures by design, which makes this panel the only
   * readout a sighted pointer or keyboard user gets: clipped, there is nothing
   * left to read. (Screen-reader users are unaffected — the trigger carries the
   * whole reading in its `aria-label`.)
   *
   * Defaults to `bottom` so the agents-panel call site, which has room below,
   * is unchanged.
   */
  side?: 'top' | 'bottom';
  className?: string;
}): React.JSX.Element | null {
  // The model's OWN window, or NOTHING. A window of 0 is rejected here, not
  // just upstream: this is the ONE place that divides by it, and the result
  // ("Context Infinity% full") would land in the accessible name.
  //
  // There is deliberately no assumed fallback. Substituting a flat 200k made
  // the meter state a denominator nobody had reported — so a 1M-window model
  // read as a fifth full before it had said anything. When the window is
  // unknown the count is shown bare and the ring is withheld: "26k used" is
  // true, "26k / 200k · 13%" was not.
  const windowTokens =
    contextWindowTokens !== null && contextWindowTokens > 0
      ? contextWindowTokens
      : null;
  if (contextTokens === null && spentUsd === null) {
    // Nothing to say AND nothing said about why: a turn that has yet to report
    // anything, which is a moment rather than a fact. The meter stays absent.
    if (unavailableReason === null) {
      return null;
    }
    // Nothing to say, and a REASON for it. A hollow ring holds the spot the
    // sibling agent's meter occupies and carries the sentence — no figures
    // invented, no standing paragraph, and the question is answered exactly
    // where it gets asked.
    return (
      <MeterReadout
        side={side}
        className={className}
        label={unavailableReason}
        ring={
          // An EMPTY ring at the same 14px, in the muted tone: it holds the spot
          // the sibling agent's meter occupies without implying a reading. No
          // `label`, for the reason the filled ring has none — the button says it.
          <ProgressRing
            fraction={0}
            size={14}
            className="text-muted-foreground/40"
          />
        }>
        <p className="text-[11px] text-muted-foreground">{unavailableReason}</p>
      </MeterReadout>
    );
  }

  // No ring to hover means no way to reach a hover-only readout, so the figures
  // stay on screen. This is the "the CLI has not told us the window" case, and
  // it must not degrade into showing the user nothing at all.
  //
  // Testing the two INPUTS rather than a derived fraction is what narrows them
  // to numbers for the ring branch below; deriving first and testing that left
  // both operands nullable everywhere they are actually used.
  if (contextTokens === null || windowTokens === null) {
    return (
      <span
        // The SAME `data-slot` as the ring branch below, so "where in the
        // composer does the meter sit" is one query regardless of which shape
        // it currently takes. (Both branches render something; the case with
        // nothing to say returned null above.)
        data-slot="context-meter"
        className={cn(
          'flex items-center gap-2 text-xs text-muted-foreground',
          className,
        )}>
        {contextTokens !== null ? (
          <span title="Context of the latest turn — the model's window has not been reported yet">
            ctx {formatTokens(contextTokens)}
          </span>
        ) : null}
        {spentUsd !== null ? (
          <span title="Total spend across this run's turns">
            {formatUsd(spentUsd)}
          </span>
        ) : null}
      </span>
    );
  }

  const fraction = contextTokens / windowTokens;
  const percent = Math.round(fraction * 100);
  return (
    <MeterReadout
      side={side}
      className={className}
      label={
        `Context ${percent}% full — ${formatTokens(contextTokens)} of ${formatTokens(windowTokens)}` +
        (spentUsd === null ? '' : `, ${formatUsd(spentUsd)} spent`)
      }
      ring={
        <ProgressRing
          fraction={fraction}
          // Sized to sit INSIDE a line of 12px text rather than beside it.
          // With the percentage gone from the middle the arc frames no glyphs,
          // so it can read as a gauge; at 18px it was still setting the height
          // of every row it shared — which is what pushed the agent card's
          // context readout onto a line of its own.
          size={14}
          // No `label`, unlike every other use: the button around it already
          // carries the reading as its accessible name, and labelling both makes
          // a screen reader announce the figure twice.
          className={cn(
            fraction >= ALARM_AT
              ? 'text-destructive'
              : fraction >= WARN_AT
                ? 'text-warning'
                : 'text-success',
          )}
        />
      }>
      <span className="flex flex-col gap-0.5 text-xs whitespace-nowrap text-muted-foreground">
        <span className="font-medium text-foreground">
          {formatTokens(contextTokens)} / {formatTokens(windowTokens)}
        </span>
        <span>{percent}% of the model&rsquo;s context window</span>
        {spentUsd !== null ? (
          <span>{formatUsd(spentUsd)} spent across this run</span>
        ) : null}
      </span>
    </MeterReadout>
  );
}
