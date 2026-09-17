import { Minimize2 } from 'lucide-react';

import { Select } from '../components/ui/select';
import {
  AUTO_COMPACT_OFF_LABEL,
  AUTO_COMPACT_PERCENTS,
  autoCompactLabel,
} from './auto-compact';

/** The menu's "never" row — a token rather than `''`, so the menu can check it. */
const OFF = '__off__';

/**
 * The auto-compact threshold as a standalone picker: compact the conversation
 * once its context reaches this share of the window. The composer offers the
 * same choice as a row of `ModelSettingsSelect`; this is the form for a surface
 * with a label column of its own — the workflow node inspector.
 *
 * A stored value outside {@link AUTO_COMPACT_PERCENTS} (a hand-edited YAML
 * node) is added back as a row rather than dropped, since it is what runs.
 */
export function AutoCompactSelect({
  value,
  onChange,
  variant = 'ghost',
  className,
  id,
}: {
  /** The threshold, or null for never. */
  value: number | null;
  onChange: (percent: number | null) => void;
  /** `ghost` is the composer chip, `default` the inspector's bordered field. */
  variant?: 'ghost' | 'default';
  className?: string;
  id?: string;
}): React.JSX.Element {
  const percents =
    value !== null && !AUTO_COMPACT_PERCENTS.includes(value)
      ? [...AUTO_COMPACT_PERCENTS, value].sort((a, b) => a - b)
      : AUTO_COMPACT_PERCENTS;
  return (
    <Select
      variant={variant}
      id={id}
      aria-label="Auto-compact"
      title="Auto-compact — compact the conversation once its context fills this share of the window"
      className={className}
      leadingIcon={<Minimize2 />}
      value={value === null ? OFF : String(value)}
      groups={[
        {
          items: percents.map((percent) => ({
            value: String(percent),
            label: autoCompactLabel(percent),
          })),
        },
        { items: [{ value: OFF, label: AUTO_COMPACT_OFF_LABEL }] },
      ]}
      onValueChange={(next) => onChange(next === OFF ? null : Number(next))}
    />
  );
}
