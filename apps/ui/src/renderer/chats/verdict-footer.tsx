import { Button } from '../components/ui/button';
import { HazardAck, type useHazardGate } from './text-hazard-gate';

/**
 * The verdict footer of an approval card: the hazard tick, Approve and Deny,
 * and the verdict line once the call is answered. A permission card and a
 * thread message share it, so Approve is gated the same way on both.
 */
export function VerdictFooter({
  verdict,
  expired,
  sending,
  gate,
  respond,
  optionButtons,
  notes,
  verdictLine,
}: {
  verdict: boolean | null;
  expired: boolean;
  sending: boolean;
  gate: ReturnType<typeof useHazardGate>;
  respond: (allow: boolean) => void;
  /**
   * The options the agent offers beside a one-time Approve. Approve and Deny
   * stay first and last: a one-time answer is the default, and what the agent
   * would remember sits between them, in its own words. An option that lets
   * the call run is gated on the hazard tick exactly as Approve is.
   */
  optionButtons?: React.ReactNode;
  /** Remarks drawn under the answer row. */
  notes?: React.ReactNode;
  /** The verdict line, drawn once the call is answered. */
  verdictLine: React.ReactNode;
}): React.JSX.Element {
  if (expired && verdict === null) {
    return (
      <p className="text-xs text-muted-foreground">
        ⏱ expired — the turn ended before an answer
      </p>
    );
  }
  if (sending) {
    return <p className="text-xs text-muted-foreground">Sending…</p>;
  }
  if (verdict !== null) {
    return <>{verdictLine}</>;
  }
  return (
    <div className="flex flex-col gap-2">
      {/* Deny is never gated here — refusing a suspicious call must stay
          one click, on the same rule the question card's arity warning
          follows: only the button that COMMITS needs a second thought. */}
      {gate.hazards.gates ? (
        <HazardAck
          id={gate.ackId}
          checked={gate.acknowledged}
          onCheckedChange={gate.setAcknowledged}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={gate.blocksApprove}
          onClick={() => respond(true)}>
          Approve
        </Button>
        {optionButtons}
        <Button type="button" variant="outline" onClick={() => respond(false)}>
          Deny
        </Button>
      </div>
      {notes}
    </div>
  );
}
