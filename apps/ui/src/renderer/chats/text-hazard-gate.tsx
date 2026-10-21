import { TriangleAlert } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';

import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { cn } from '../components/ui/utils';
import {
  type HazardClass,
  type HazardHit,
  type HazardScanResult,
  scanTextHazards,
} from './text-hazards';

/** A short, human-readable name for a hazard class — never the character itself. */
const HAZARD_CLASS_LABEL: Record<HazardClass, string> = {
  bidi: 'Bidirectional override',
  invisible: 'Invisible character',
  mixedScript: 'Look-alike character from another script',
};

/** `Bidirectional override — U+202E` — the codepoint, never the character. */
function hazardHitLabel(hit: HazardHit): string {
  const hex = hit.codePoint.toString(16).toUpperCase().padStart(4, '0');
  return `${HAZARD_CLASS_LABEL[hit.class]} — U+${hex}`;
}

/**
 * The Approve gate an approval card puts in front of text it is about to act
 * on: the scan of everything the card displays, and whether the user has
 * acknowledged a gating hit.
 *
 * `useOneShotVerdict` freezes only AFTER an answer is sent, so it cannot gate
 * the Approve press itself. The acknowledgement resets DURING render, keyed on
 * the scanned TEXT rather than on an input object's identity (a parent that
 * rebuilds that object every render must not un-tick this the instant it is
 * ticked), so there is no committed frame where a stale tick still gates new,
 * unreviewed text.
 */
export function useHazardGate(scanText: string): {
  hazards: HazardScanResult;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  /** Approve is held until the user acknowledges a gating hit. */
  blocksApprove: boolean;
  ackId: string;
} {
  const hazards = useMemo(() => scanTextHazards(scanText), [scanText]);
  const [acknowledged, setAcknowledged] = useState(false);
  const acknowledgedForRef = useRef(scanText);
  if (acknowledgedForRef.current !== scanText) {
    acknowledgedForRef.current = scanText;
    if (acknowledged) {
      setAcknowledged(false);
    }
  }
  const ackId = useId();
  return {
    hazards,
    acknowledged,
    setAcknowledged,
    blocksApprove: hazards.gates && !acknowledged,
    ackId,
  };
}

/** The banner naming every distinct hazard in what the card shows. */
export function HazardWarning({
  hazards,
  subject,
}: {
  hazards: HazardScanResult;
  /** What the hazards are in, as the banner says it: `this input`. */
  subject: string;
}): React.JSX.Element | null {
  if (hazards.hits.length === 0) {
    return null;
  }
  return (
    <div
      data-slot="hazard-warning"
      className={cn(
        'flex flex-col gap-1 rounded-md border px-2.5 py-2 text-xs',
        hazards.gates
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-warning/30 bg-warning/10 text-warning',
      )}>
      <div className="flex items-center gap-1.5 font-medium">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        <span>
          {hazards.gates
            ? `Hidden or reordering characters in ${subject}`
            : `Look-alike characters in ${subject}`}
        </span>
      </div>
      {/* Named by CLASS and CODEPOINT alone — never the character, which
          for a bidi hit would reorder this very warning around it. */}
      {/* One row per DISTINCT hazard, not per hit. The scanned text
          deliberately overlaps — a patch's `new_string` is read once inside
          the input's JSON and again from the diff body — so a single
          character yields two hits at two offsets. The row carries no
          offset, so both would render as the identical sentence and read
          as two separate hazards. */}
      <div className="flex flex-col gap-0.5 pl-5">
        {[
          ...new Map(
            hazards.hits.map((hit) => [`${hit.class}-${hit.codePoint}`, hit]),
          ).values(),
        ].map((hit) => (
          <span key={`${hit.class}-${hit.codePoint}`}>
            {hazardHitLabel(hit)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The switch that releases a gated Approve. Never on Deny/Decline: refusing
 * suspicious text must stay one click — only the button that COMMITS needs a
 * second thought.
 */
export function HazardAck({
  id,
  checked,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
      <Label
        htmlFor={id}
        className="cursor-pointer text-xs font-normal text-muted-foreground">
        I&apos;ve reviewed the characters above and want to approve anyway
      </Label>
    </div>
  );
}
