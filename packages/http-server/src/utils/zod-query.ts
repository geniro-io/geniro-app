import z from 'zod';

const coerceQueryValueToStringArray = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.includes(',')) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  return [value];
};

/**
 * Accepts common query-string representations of repeated params:
 * - `?param=a` -> `['a']`
 * - `?param=a&param=b` -> `['a', 'b']` (already an array)
 * - `?param=a,b` -> `['a', 'b']`
 */
export const zodQueryArray = <TItem extends z.ZodTypeAny>(itemSchema: TItem) =>
  z.preprocess(coerceQueryValueToStringArray, z.array(itemSchema));
