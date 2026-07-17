import { useEffect, useState } from 'react';

import type { CliKind } from '../../shared/contracts';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { AGENT_MODEL_OPTIONS } from './node-schema';

/** Sentinel option value that switches the field to free-text entry. */
const CUSTOM = '__custom__';

/**
 * The inspector's model picker: the agent CLI's documented aliases as a
 * select plus a Custom… option opening free-text entry for full model ids
 * (e.g. `claude-fable-5`). Every node names its model explicitly — a node
 * arriving with none (a fresh palette drop, imported YAML) adopts the first
 * alias on mount so the select never shows a model the run wouldn't use. A
 * stored model outside the alias list starts in custom mode showing exactly
 * the value that will be passed to `--model`.
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
  /** The node's stored model ('' = not set yet — adopts the first alias). */
  value: string;
  onChange: (model: string | undefined) => void;
}): React.JSX.Element {
  const options = AGENT_MODEL_OPTIONS[agent];
  const [custom, setCustom] = useState(
    () => value !== '' && !options.includes(value),
  );

  // Adopt the first alias for a model-less node — but never while the custom
  // input is open, where a transiently empty value is just mid-typing.
  useEffect(() => {
    if (value === '' && !custom && options.length > 0) {
      onChange(options[0]);
    }
  }, [value, custom, options, onChange]);

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
