/**
 * Argument names a deferred tool's first call guesses for one of its own:
 * synonym → the name the tool reads.
 */
export type ArgSynonyms = Readonly<Record<string, string>>;

export type SynonymArgs =
  { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * The call's arguments with every synonym renamed to the name the tool reads.
 * A synonym sent beside that name, or beside another synonym of it, must agree
 * with it. A null is left for the tool's own reader, which reads it as absent.
 */
export function applyArgSynonyms(
  args: Record<string, unknown>,
  synonyms: ArgSynonyms,
): SynonymArgs {
  const renamed = new Map<string, unknown>();
  const givenAs = new Map<string, string>();
  for (const [key, value] of Object.entries(args)) {
    const name =
      value !== null && Object.hasOwn(synonyms, key) ? synonyms[key]! : key;
    if (value === null && renamed.get(name) !== undefined) {
      continue;
    }
    const earlier = givenAs.get(name);
    if (
      earlier !== undefined &&
      JSON.stringify(renamed.get(name)) !== JSON.stringify(value)
    ) {
      return {
        ok: false,
        error: `send ${name} once — ${earlier} and ${key} name the same argument and disagree`,
      };
    }
    renamed.set(name, value);
    if (value !== null) {
      givenAs.set(name, key);
    }
  }
  return { ok: true, args: Object.fromEntries(renamed) };
}

/**
 * A tool's input schema with each synonym declared right after the name it
 * stands for, so a client that refuses an undeclared argument sends the call.
 * A required name with a synonym is no longer required by the schema — its
 * reader still requires one of them.
 */
export function withSynonymProperties(
  schema: Record<string, unknown>,
  synonyms: ArgSynonyms,
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const withSynonyms: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const own = Object.entries(synonyms)
      .filter(([, target]) => target === name)
      .map(([synonym]) => synonym);
    const required =
      Array.isArray(schema.required) && schema.required.includes(name);
    withSynonyms[name] =
      required && own.length > 0
        ? {
            ...property,
            description:
              `${String(property.description ?? '')} Required (or one of ${own.map((synonym) => `\`${synonym}\``).join(', ')}).`.trim(),
          }
        : property;
    for (const synonym of own) {
      withSynonyms[synonym] = {
        ...property,
        description: `Same as \`${name}\` — send one of them.`,
      };
    }
  }
  const result: Record<string, unknown> = {
    ...schema,
    properties: withSynonyms,
  };
  if (Array.isArray(schema.required)) {
    const synonymTargets = new Set(Object.values(synonyms));
    const required = (schema.required as string[]).filter(
      (name) => !synonymTargets.has(name),
    );
    if (required.length > 0) {
      result.required = required;
    } else {
      delete result.required;
    }
  }
  return result;
}

/** A refusal that opens with the call the tool expects, then says what was wrong. */
export function leadWithCall(rightCall: string, reason: string): string {
  return `${rightCall}\n${reason}`;
}

/** A count over its tool's limit, read as the limit instead of refused. */
export function clampCount(
  args: Record<string, unknown>,
  key: string,
  max: number,
): Record<string, unknown> {
  const value = args[key];
  return typeof value === 'number' && value > max
    ? { ...args, [key]: max }
    : args;
}
