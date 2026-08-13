import { Gauge } from 'lucide-react';

import { Chip } from '../components/ui/chip';

/**
 * A read-only effort chip, for a CLI whose effort is not separately selectable.
 *
 * It stands in for {@link EffortSelect} where that picker has no vocabulary to
 * offer, and states what the chosen model already carries. The user changes it
 * by picking a different model row — which is now legible, because
 * {@link ModelSelect} shows each row's effort as its hint.
 *
 * **Read-only is not a shortfall, and the chip has to SAY so.** A value the user
 * cannot change, with no cause given, reads as broken — which is how this was
 * reported ("I cannot change the effort of a Cursor model; in the Cursor UI I
 * can"). So the tooltip carries the DAEMON's own sentence for the refusal,
 * naming where the effort does change. It is never composed here: which CLI
 * lacks a picker, and what to say about it, is that adapter's fact, and a
 * sentence invented in the renderer is one the adapter cannot keep true.
 *
 * That is also why nothing here names an agent. It used to open with
 * `agentKind !== 'cursor-agent'` and parse the effort out of a cursor model id
 * itself — so a CLI that gained an effort-bearing id would have shown nothing,
 * and one that gained a real picker would have shown both controls.
 */
export function ModelEffortReadout({
  effort,
  unavailableReason,
}: {
  /**
   * The effort the selected model states, as the daemon reported it
   * (`AgentModel.effort`). Null when no model is chosen, or when the model
   * states none — in both cases there is nothing to read out.
   */
  effort: string | null;
  /**
   * Why this CLI offers no effort picker, from `GET /v1/capabilities`
   * `modelEfforts[]`. Null means it HAS one, and then this chip must not render
   * at all: `EffortSelect` is on screen and two controls for one value is worse
   * than none. Undefined means the capability report has not landed — also
   * nothing, since a chip whose explanation is still in flight would appear
   * inert for exactly as long as it takes to arrive.
   */
  unavailableReason: string | null | undefined;
}): React.JSX.Element | null {
  // One condition for three cases that all mean "render nothing" — see the two
  // prop docs above for why each of them does.
  if (effort === null || !unavailableReason) {
    return null;
  }
  return (
    <Chip
      tone="muted"
      title={`Reasoning effort ${effort} — ${unavailableReason}`}>
      <Gauge aria-hidden="true" />
      {effort}
    </Chip>
  );
}
