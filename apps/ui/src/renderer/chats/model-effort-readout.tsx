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
    <Chip tone="muted" title={`Reasoning effort baked into this model: ${effort}`}>
      <Gauge aria-hidden="true" />
      {effort}
    </Chip>
  );
}
