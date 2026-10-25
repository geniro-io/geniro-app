import { SettingRow } from '../components/setting-row';
import { LoadingChip } from '../components/ui/loading-chip';

/** What the wait is for — the composer's pending row says the same words. */
export const PENDING_MODEL_SETTINGS_TEXT = 'Reading what this model offers…';

/**
 * The ONE labelled row that stands where a model's settings will be, while the
 * CLI is still being asked what this model offers — the label-column twin of
 * the composer's `PENDING_AXES` row in `model-settings-select.tsx`.
 *
 * Without it "not asked yet" and "this model has none" are the same picture,
 * because every axis row is DROPPED on an empty listing, and a cold listing is
 * one real CLI handshake (seconds, not a frame). REPORTED from the builder's
 * node inspector: "когда я выбираю новую модель, я не вижу параметра effort и
 * никакого лоадера… через 10-15 секунд я начинаю видеть этот параметр".
 *
 * One row rather than a loading chip per axis, for the composer's reason:
 * which axes exist is itself the answer being waited for, so an `Effort` row
 * that spins and then vanishes would claim an axis the model may not have.
 */
export function ModelSettingsPendingRow({
  width,
}: {
  width?: 'default' | 'compact';
}): React.JSX.Element {
  return (
    <SettingRow width={width} label="Options">
      <LoadingChip noun="model options" title={PENDING_MODEL_SETTINGS_TEXT} />
    </SettingRow>
  );
}
