import { OptionList } from './ui/option-list';

/** One thing a delete may do with what is filed under the deleted place. */
export interface FateOption<T extends string> {
  fate: T;
  label: string;
  detail: string;
}

/** The choice a delete dialog offers about what a deleted place holds. */
export function FateOptions<T extends string>({
  label,
  fates,
  value,
  onChange,
}: {
  /** What the list decides about. */
  label: string;
  fates: readonly FateOption<T>[];
  value: T;
  onChange: (fate: T) => void;
}): React.JSX.Element {
  const picked = fates.find((entry) => entry.fate === value) ?? fates[0];
  return (
    <OptionList
      arity="one"
      label={label}
      options={fates.map((entry) => entry.label)}
      details={fates.map((entry) => entry.detail)}
      selected={picked ? [picked.label] : []}
      onPick={(option) => {
        const chosen = fates.find((entry) => entry.label === option);
        if (chosen) {
          onChange(chosen.fate);
        }
      }}
    />
  );
}
