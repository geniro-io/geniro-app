import { Gauge } from 'lucide-react';

import type { CliKind } from '../../shared/contracts';
import { Chip } from '../components/ui/chip';
import { parseModelEffort } from './model-effort';

/**
 * A read-only effort chip for cursor-agent.
 *
 * That CLI has no separate effort control — effort rides in the model id — so
 * {@link EffortSelect} stays absent and this states what the chosen model
 * already carries. Muted and non-interactive: the user changes effort by
 * picking a different model row, not a second picker.
 *
 * Read-only is not a shortfall, and the tooltip has to SAY so. Probed on
 * cursor-agent 2026.08.04-aaa8809 (recorded at `CursorAcpAdapter`'s `efforts`
 * field): the agent accepts only the exact model ids it enumerated, rejecting
 * every recomposed effort with `-32602 Invalid params` — including a value it
 * ships on another model — and it enumerates exactly one effort per model. So a
 * real picker here could only ever produce a failed turn. A chip that states a
 * value and offers no way to change it reads as broken, which is what got this
 * reported; naming the action that DOES work is the whole fix available.
 */
export function ModelEffortReadout({
  agentKind,
  modelId,
}: {
  agentKind: CliKind;
  /** The model id the run will pass — not the friendly label. */
  modelId: string | null;
}): React.JSX.Element | null {
  if (agentKind !== 'cursor-agent' || modelId === null) {
    return null;
  }
  const effort = parseModelEffort(modelId);
  if (effort === null) {
    return null;
  }
  return (
    <Chip
      tone="muted"
      title={`Reasoning effort ${effort} — cursor builds it into the model, so change it by choosing a different model`}>
      <Gauge aria-hidden="true" />
      {effort}
    </Chip>
  );
}
