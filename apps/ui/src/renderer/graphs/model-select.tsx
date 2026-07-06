import { useState } from 'react';

import type { CliKind } from '../../shared/contracts';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { AGENT_MODEL_OPTIONS } from './node-schema';

/** Sentinel option value that switches the field to free-text entry. */
const CUSTOM = '__custom__';

/**
 * The inspector's model picker: the agent CLI's documented aliases as a
 * select ("CLI default" = no `--model` flag) plus a Custom… option opening
 * free-text entry for full model ids (e.g. `claude-fable-5`). A stored model
 * outside the alias list (imported YAML, hand-edited file) starts in custom
 * mode showing exactly the value that will be passed to `--model`.
 *
 * Mount with `key={node.id}` — the select/custom mode is derived from the
 * value once per node, so it must not leak across node selections.
 */
export function ModelSelect({
  id,
  agent,
  value,
  onChange,
}: {
  id: string;
  agent: CliKind;
  /** The node's stored model ('' = unset → the CLI default). */
  value: string;
  onChange: (model: string | undefined) => void;
}): React.JSX.Element {
  const options = AGENT_MODEL_OPTIONS[agent];
  const [custom, setCustom] = useState(
    () => value !== '' && !options.includes(value),
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        id={id}
        value={custom ? CUSTOM : value}
        onChange={(event) => {
          if (event.target.value === CUSTOM) {
            // Keep the stored model — the input below takes over editing it.
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(event.target.value || undefined);
        }}>
        <option value="">CLI default</option>
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </Select>
      {custom ? (
        <Input
          aria-label="Custom model id"
          value={value}
          placeholder="full model id, e.g. claude-fable-5"
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      ) : null}
    </div>
  );
}
