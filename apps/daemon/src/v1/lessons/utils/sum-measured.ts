/** A sum over figures where null is "not measured": null when none was. */
export function sumMeasured(values: readonly (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0
    ? null
    : measured.reduce((total, value) => total + value, 0);
}
