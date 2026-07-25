import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Post-processing for the schema components `nestjs-zod` contributes to the
 * OpenAPI document, applied after `cleanupOpenApiDoc`.
 *
 * nestjs-zod renders the SAME zod schema twice with different names — once per
 * direction — and neither name is what a client generator should see:
 *
 * - a response DTO goes through `Dto.Output`, so every schema carrying a zod
 *   `.meta({ id })` lands as `<Id>_Output`;
 * - a request-body DTO is exploded by Nest's own schema factory, so its nested
 *   schemas land as `<DtoName><PropertyPath>` (e.g. `SaveWorkflowDtoWorkflow`)
 *   with the zod id dropped and `additionalProperties: false` not carried over.
 *
 * Left alone, `openapi-generator` emits `WorkflowOutput` AND
 * `SaveWorkflowDtoWorkflow` for one domain type. This module collapses them:
 * the `_Output` suffix is dropped, then every anonymous component that is
 * structurally identical to an id-bearing one is aliased onto it, repeatedly,
 * until a fixed point.
 *
 * Merging deliberately anchors on the zod ids. Two ANONYMOUS components are
 * never merged with each other however alike they look — `ImportWorkflowDto`
 * and `ExportWorkflowDto` are both `{ path: string }` and must stay two names —
 * and two ID-BEARING components are never merged either, since distinct ids are
 * an explicit statement that the author wants distinct types.
 *
 * Purely a naming pass; the only body edits are the two keywords that make the
 * same schema look different in the two directions, both dropped everywhere:
 * `id` (non-standard here — it is zod metadata, not OpenAPI) and
 * `additionalProperties: false` (zod objects STRIP unknown keys rather than
 * rejecting them, so "closed" was never true of a request body anyway).
 */

const REF_PREFIX = '#/components/schemas/';

/** Suffix nestjs-zod appends when rendering a schema's output projection. */
const OUTPUT_SUFFIX = '_Output';

type SchemaMap = Record<string, unknown>;

/** Deep copy of `value` with every component `$ref` remapped through `rename`. */
const mapRefs = (value: unknown, rename: (name: string) => string): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => mapRefs(entry, rename));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === '$ref' &&
      typeof entry === 'string' &&
      entry.startsWith(REF_PREFIX)
        ? `${REF_PREFIX}${rename(entry.slice(REF_PREFIX.length))}`
        : mapRefs(entry, rename);
  }
  return out;
};

/**
 * Deep copy with the two direction-dependent keywords removed: the zod `id`
 * metadata and a literal `additionalProperties: false`. An `additionalProperties`
 * that carries a SCHEMA (a record type's value shape) is left untouched, as is
 * any property actually named `id`.
 */
const dropDirectionalKeywords = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(dropDirectionalKeywords);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === 'id' && typeof entry === 'string') {
      continue;
    }
    if (key === 'additionalProperties' && entry === false) {
      continue;
    }
    // `properties` maps property NAMES to schemas — recurse into the values but
    // never treat a key like `id` there as a keyword.
    out[key] =
      key === 'properties'
        ? Object.fromEntries(
            Object.entries(entry as Record<string, unknown>).map(([k, v]) => [
              k,
              dropDirectionalKeywords(v),
            ]),
          )
        : dropDirectionalKeywords(entry);
  }
  return out;
};

/**
 * Key-order-independent serialization, so two components built by different
 * code paths compare equal when they describe the same schema.
 */
const stableKey = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(',')}]`;
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
};

/** Deterministic pick when a schema matches several canonical names. */
const preferredName = (a: string, b: string): string => {
  if (a.length !== b.length) {
    return a.length < b.length ? a : b;
  }
  return a.localeCompare(b) <= 0 ? a : b;
};

/** Apply `renames` to every `$ref` in the document and to the component keys. */
const applyRenames = (
  doc: OpenAPIObject,
  renames: Map<string, string>,
): OpenAPIObject => {
  const rename = (name: string): string => renames.get(name) ?? name;
  const rewritten = mapRefs(doc, rename) as OpenAPIObject;
  const schemas: SchemaMap = {};
  for (const [name, schema] of Object.entries(
    (rewritten.components?.schemas ?? {}) as SchemaMap,
  )) {
    // Aliases are only ever created for components already proven identical, so
    // the canonical body wins and the duplicate is dropped.
    schemas[rename(name)] ??= schema;
  }
  return {
    ...rewritten,
    components: {
      ...rewritten.components,
      schemas,
    } as OpenAPIObject['components'],
  };
};

/**
 * Every component `$ref` in the document that resolves to nothing.
 *
 * Exported for the guard in `setupSwagger`: nestjs-zod produces exactly this
 * when a DTO used as an ARRAY response was built from a schema carrying a zod
 * `.meta({ id })` — the component is registered under the id but the response
 * still points at the DTO class name. A dangling ref silently degrades the
 * generated client to `any`, so it must fail loudly instead.
 */
export const findDanglingSchemaRefs = (doc: OpenAPIObject): string[] => {
  const known = new Set(Object.keys(doc.components?.schemas ?? {}));
  const dangling = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        key === '$ref' &&
        typeof entry === 'string' &&
        entry.startsWith(REF_PREFIX)
      ) {
        const name = entry.slice(REF_PREFIX.length);
        if (!known.has(name)) {
          dangling.add(name);
        }
        continue;
      }
      visit(entry);
    }
  };
  visit(doc);
  return [...dangling].sort();
};

/**
 * Collapse the duplicate schema components nestjs-zod emits per direction.
 * See the module doc block for the rules. Idempotent.
 */
export const canonicalizeOpenApiSchemas = (
  doc: OpenAPIObject,
): OpenAPIObject => {
  const initial = (doc.components?.schemas ?? {}) as SchemaMap;
  if (Object.keys(initial).length === 0) {
    return doc;
  }

  // Components that carry a zod id are the canonical ones — everything else is
  // an anonymous DTO root or one of Nest's request-side expansions. Recorded
  // BEFORE the id keyword is dropped, and under the name the `_Output` pass
  // below will give them.
  const canonicalNames = new Set<string>();
  for (const [name, schema] of Object.entries(initial)) {
    if (schema !== null && typeof schema === 'object' && 'id' in schema) {
      canonicalNames.add(
        name.endsWith(OUTPUT_SUFFIX)
          ? name.slice(0, -OUTPUT_SUFFIX.length)
          : name,
      );
    }
  }

  const normalized: SchemaMap = {};
  for (const [name, schema] of Object.entries(initial)) {
    normalized[name] = dropDirectionalKeywords(schema);
  }
  let current: OpenAPIObject = {
    ...doc,
    components: {
      ...doc.components,
      schemas: normalized,
    } as OpenAPIObject['components'],
  };

  // Pass 1 — drop the `_Output` suffix wherever the bare name is free.
  const names = new Set(Object.keys(normalized));
  const unsuffix = new Map<string, string>();
  for (const name of names) {
    if (!name.endsWith(OUTPUT_SUFFIX)) {
      continue;
    }
    const base = name.slice(0, -OUTPUT_SUFFIX.length);
    if (base.length > 0 && !names.has(base)) {
      unsuffix.set(name, base);
    }
  }
  if (unsuffix.size > 0) {
    current = applyRenames(current, unsuffix);
  }

  // Pass 2 — alias anonymous components onto the identical canonical one, until
  // stable. One round only unifies the leaves; the round after that sees their
  // parents become identical (their differing `$ref`s now point at the same
  // name), and so on up the schema graph — so the loop runs at most once per
  // level of nesting, and each round strictly removes at least one component.
  for (;;) {
    const schemas = (current.components?.schemas ?? {}) as SchemaMap;
    const canonicalByShape = new Map<string, string>();
    for (const [name, schema] of Object.entries(schemas)) {
      if (!canonicalNames.has(name)) {
        continue;
      }
      const key = stableKey(schema);
      const winner = canonicalByShape.get(key);
      canonicalByShape.set(
        key,
        winner === undefined ? name : preferredName(winner, name),
      );
    }

    const renames = new Map<string, string>();
    for (const [name, schema] of Object.entries(schemas)) {
      if (canonicalNames.has(name)) {
        continue;
      }
      const target = canonicalByShape.get(stableKey(schema));
      if (target !== undefined && target !== name) {
        renames.set(name, target);
      }
    }

    if (renames.size === 0) {
      return current;
    }
    current = applyRenames(current, renames);
  }
};
