import { type OutputUnit, Validator } from '@cfworker/json-schema';

import {
  MAX_UI_MESSAGES,
  MAX_UI_REGEX_LENGTH,
  UI_MEDIA_URL_PREFIX,
} from '../../chat.types';
import { A2UI_AGENT_TO_RENDERER_SCHEMA } from './schemas/agent-to-renderer.schema';
import { A2UI_BASIC_CATALOG_SCHEMA } from './schemas/basic-catalog.schema';
import { A2UI_COMMON_TYPES_SCHEMA } from './schemas/common-types.schema';

export type A2uiComponent = { id: string; component: string } & Record<
  string,
  unknown
>;

export type A2uiMessage =
  | {
      kind: 'createSurface';
      surfaceId: string;
      components: A2uiComponent[] | null;
      dataModel: Record<string, unknown> | null;
    }
  | { kind: 'updateComponents'; surfaceId: string; components: A2uiComponent[] }
  | { kind: 'updateDataModel'; surfaceId: string; path: string; value: unknown }
  | { kind: 'deleteSurface'; surfaceId: string };

export type A2uiMessagesReading =
  | { ok: true; surfaceId: string; messages: A2uiMessage[] }
  | { ok: false; error: string };

const SPEC_BASE = 'https://a2ui.org/specification/v1_0/';
const COMMON_ID = `${SPEC_BASE}common_types.json`;
const CATALOG_ID = `${SPEC_BASE}catalog.json`;

export const A2UI_FUNCTIONS = Object.keys(
  A2UI_BASIC_CATALOG_SCHEMA.functions as Record<string, unknown>,
);
export const A2UI_COMPONENTS = Object.keys(
  A2UI_BASIC_CATALOG_SCHEMA.components as Record<string, unknown>,
);
const MEDIA_COMPONENTS: Record<string, readonly string[]> = {
  Image: ['url'],
  Video: ['url', 'posterUrl'],
  AudioPlayer: ['url'],
};
const MESSAGE_KINDS = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
] as const;
const UNSUPPORTED_KINDS = ['callRendererFunction', 'agentFunctionResponse'];
const ENVELOPE_KEYS: Record<(typeof MESSAGE_KINDS)[number], readonly string[]> =
  {
    createSurface: [
      'surfaceId',
      'catalogId',
      'sendDataModel',
      'components',
      'dataModel',
      'metadata',
    ],
    updateComponents: ['surfaceId', 'components'],
    updateDataModel: ['surfaceId', 'path', 'value'],
    deleteSurface: ['surfaceId'],
  };
const WRAPPER_KEYWORDS = new Set([
  'properties',
  'allOf',
  'anyOf',
  'oneOf',
  '$ref',
  'false',
  'items',
  'prefixItems',
  'if',
  'then',
  'else',
  'not',
  'dependentSchemas',
]);

const componentValidators = new Map<string, Validator>();

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === '$ref' && typeof entry === 'string'
        ? entry
            .replace(/^#\/components\//, '#/$defs/component.')
            .replace(/^#\/functions\//, '#/$defs/function.')
        : rewriteRefs(entry),
    ]),
  );
}

function indexedCatalog(): Record<string, unknown> {
  const catalog = rewriteRefs(A2UI_BASIC_CATALOG_SCHEMA) as Record<
    string,
    unknown
  >;
  const prefixed = (prefix: string, group: unknown): [string, unknown][] =>
    Object.entries(isRecord(group) ? group : {}).map(([name, schema]) => [
      `${prefix}.${name}`,
      schema,
    ]);
  return {
    ...catalog,
    $defs: {
      ...(isRecord(catalog.$defs) ? catalog.$defs : {}),
      ...Object.fromEntries([
        ...prefixed('component', catalog.components),
        ...prefixed('function', catalog.functions),
      ]),
    },
  };
}

let catalogSchema: Record<string, unknown> | null = null;

function componentValidator(name: string): Validator {
  const cached = componentValidators.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const validator = new Validator(
    {
      $id: `https://geniro.local/a2ui/${name}.json`,
      allOf: [
        { $ref: `${COMMON_ID}#/$defs/ComponentCommon` },
        { $ref: `${CATALOG_ID}#/$defs/component.${name}` },
      ],
      unevaluatedProperties: false,
    },
    '2020-12',
    false,
  );
  validator.addSchema(A2UI_COMMON_TYPES_SCHEMA, COMMON_ID);
  catalogSchema ??= indexedCatalog();
  validator.addSchema(catalogSchema, CATALOG_ID);
  validator.addSchema(A2UI_AGENT_TO_RENDERER_SCHEMA);
  componentValidators.set(name, validator);
  return validator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function quote(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

export class A2uiError extends Error {
  constructor(
    readonly pointer: string,
    reason: string,
  ) {
    super(reason);
  }
}

function fail(pointer: string, reason: string): never {
  throw new A2uiError(pointer, reason);
}

function locationOf(unit: OutputUnit): string {
  return unit.instanceLocation.replace(/^#/, '');
}

function reasonOf(
  unit: OutputUnit,
  instance: unknown,
): { at: string; reason: string } {
  const at = locationOf(unit);
  const property = /^Property "(.+)" does not match/.exec(unit.error)?.[1];
  if (
    (unit.keyword === 'additionalProperties' ||
      unit.keyword === 'unevaluatedProperties') &&
    property !== undefined
  ) {
    return {
      at: `${at}/${escapeSegment(property)}`,
      reason: 'is not a property this component takes',
    };
  }
  if (unit.keyword === 'enum') {
    const options = /any of (\[.*\])/.exec(unit.error)?.[1];
    const parsed: unknown = options === undefined ? null : JSON.parse(options);
    const value = pointerValue(instance, at);
    return Array.isArray(parsed)
      ? { at, reason: `${quote(value)} is not one of ${parsed.join(', ')}` }
      : { at, reason: unit.error };
  }
  if (unit.keyword === 'required') {
    const missing = /property "(.+)"/.exec(unit.error)?.[1];
    return {
      at,
      reason: missing === undefined ? unit.error : `"${missing}" is required`,
    };
  }
  return { at, reason: unit.error.replace(/^Instance /, 'value ') };
}

function pointerValue(root: unknown, pointer: string): unknown {
  let node = root;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      node = node[Number(key)];
    } else if (isRecord(node)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return node;
}

function schemaFailure(
  errors: readonly OutputUnit[],
  instance: unknown,
): { at: string; reason: string } {
  const specific = errors.filter((unit) => !WRAPPER_KEYWORDS.has(unit.keyword));
  const deeper = (unit: OutputUnit): boolean => {
    if (
      unit.keyword !== 'additionalProperties' &&
      unit.keyword !== 'unevaluatedProperties'
    ) {
      return false;
    }
    const property = /^Property "(.+)" does not match/.exec(unit.error)?.[1];
    const target = `${locationOf(unit)}/${escapeSegment(property ?? '')}`;
    return specific.some(
      (other) =>
        other !== unit &&
        locationOf(other).startsWith(target) &&
        other.keyword !== 'unevaluatedProperties',
    );
  };
  const candidates = specific.filter((unit) => !deeper(unit));
  const pool = candidates.length > 0 ? candidates : errors;
  const depth = (unit: OutputUnit): number =>
    locationOf(unit).split('/').length;
  const deepest = Math.max(...pool.map(depth));
  const atDeepest = pool.filter((unit) => depth(unit) === deepest);
  const chosen =
    atDeepest.find((unit) => unit.keyword === 'enum') ??
    atDeepest.find((unit) => unit.keyword === 'required') ??
    atDeepest.find(
      (unit) =>
        unit.keyword === 'unevaluatedProperties' ||
        unit.keyword === 'additionalProperties',
    ) ??
    atDeepest[0];
  return chosen === undefined
    ? { at: '', reason: 'does not match the A2UI schema' }
    : reasonOf(chosen, instance);
}

function walk(
  value: unknown,
  pointer: string,
  visit: (value: Record<string, unknown>, pointer: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${pointer}/${index}`, visit));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  visit(value, pointer);
  for (const [key, entry] of Object.entries(value)) {
    walk(entry, `${pointer}/${escapeSegment(key)}`, visit);
  }
}

/** A repeated group that itself repeats or alternates — the shape of catastrophic backtracking. */
export function backtracksBadly(pattern: string): boolean {
  const groups: { start: number; risky: boolean }[] = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      inClass = char !== ']';
      continue;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      groups.push({ start: index, risky: false });
    } else if (char === ')') {
      const group = groups.pop();
      const next = pattern[index + 1];
      const repeated = next === '*' || next === '+' || next === '{';
      if (group?.risky === true && repeated) {
        return true;
      }
      const outer = groups.at(-1);
      if (
        group !== undefined &&
        outer !== undefined &&
        (group.risky || repeated)
      ) {
        outer.risky = true;
      }
    } else if (char === '*' || char === '+' || char === '{' || char === '|') {
      const open = groups.at(-1);
      if (open !== undefined) {
        open.risky = true;
      }
    }
  }
  return false;
}

function checkCalls(component: Record<string, unknown>, pointer: string): void {
  walk(component, pointer, (node, at) => {
    const call = node['@call'];
    if (
      typeof call === 'string' &&
      call !== '@index' &&
      !A2UI_FUNCTIONS.includes(call)
    ) {
      fail(
        `${at}/@call`,
        `"${call}" is not a basic catalog function (${A2UI_FUNCTIONS.join(', ')})`,
      );
    }
    if (
      call === 'regex' &&
      isRecord(node.args) &&
      typeof node.args.pattern === 'string'
    ) {
      const pattern = node.args.pattern;
      if (pattern.length > MAX_UI_REGEX_LENGTH) {
        fail(
          `${at}/args/pattern`,
          `a pattern may be at most ${MAX_UI_REGEX_LENGTH} characters`,
        );
      }
      try {
        new RegExp(pattern, 'u');
      } catch {
        fail(`${at}/args/pattern`, 'is not a valid regular expression');
      }
      if (backtracksBadly(pattern)) {
        fail(
          `${at}/args/pattern`,
          'repeats a group that itself repeats or alternates, which can hang the card; write it without the nested repetition',
        );
      }
    }
  });
}

function readComponent(raw: unknown, pointer: string): A2uiComponent {
  if (!isRecord(raw)) {
    fail(pointer, 'a component must be an object');
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    fail(`${pointer}/id`, 'a component needs a non-empty string id');
  }
  if (typeof raw.component !== 'string') {
    fail(`${pointer}/component`, 'names no component');
  }
  if (!A2UI_COMPONENTS.includes(raw.component)) {
    fail(
      `${pointer}/component`,
      `"${raw.component}" is not a basic catalog component (${A2UI_COMPONENTS.join(', ')})`,
    );
  }
  checkCalls(raw, pointer);
  for (const field of MEDIA_COMPONENTS[raw.component] ?? []) {
    const url = raw[field];
    if (url !== undefined && typeof url !== 'string') {
      fail(
        `${pointer}/${field}`,
        'a media url must be a literal string, never bound to the data model',
      );
    }
    if (typeof url === 'string' && url.startsWith(UI_MEDIA_URL_PREFIX)) {
      fail(
        `${pointer}/${field}`,
        'names a file path or an http(s) URL, not a stored copy',
      );
    }
  }
  if (
    raw.component === 'Button' &&
    isRecord(raw.action) &&
    isRecord(raw.action.functionCall)
  ) {
    const call = raw.action.functionCall['@call'];
    if (call !== 'openUrl') {
      fail(
        `${pointer}/action/functionCall`,
        'a button calls a function only to open a link (openUrl); use an event to reach the agent',
      );
    }
  }
  const result = componentValidator(raw.component).validate(raw);
  if (!result.valid) {
    const { at, reason } = schemaFailure(result.errors, raw);
    fail(`${pointer}${at}`, reason);
  }
  return raw as A2uiComponent;
}

function readComponents(raw: unknown, pointer: string): A2uiComponent[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(pointer, 'must be a non-empty array of components');
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const component = readComponent(entry, `${pointer}/${index}`);
    if (seen.has(component.id)) {
      fail(
        `${pointer}/${index}/id`,
        `"${component.id}" is used by another component in this list`,
      );
    }
    seen.add(component.id);
    return component;
  });
}

function readMessage(raw: unknown, pointer: string): A2uiMessage {
  if (!isRecord(raw)) {
    fail(pointer, 'a message must be an object');
  }
  if (raw.version !== '1.0') {
    fail(`${pointer}/version`, 'must be "1.0" (A2UI v1.0)');
  }
  const unsupported = UNSUPPORTED_KINDS.find((kind) => kind in raw);
  if (unsupported !== undefined) {
    fail(`${pointer}/${unsupported}`, 'is not supported by Geniro');
  }
  const kinds = MESSAGE_KINDS.filter((kind) => kind in raw);
  const kind = kinds[0];
  if (kinds.length !== 1 || kind === undefined) {
    fail(pointer, `must hold exactly one of ${MESSAGE_KINDS.join(', ')}`);
  }
  const extra = Object.keys(raw).find(
    (key) => key !== 'version' && key !== kind,
  );
  if (extra !== undefined) {
    fail(
      `${pointer}/${escapeSegment(extra)}`,
      'is not part of an A2UI message',
    );
  }
  const body = raw[kind];
  const at = `${pointer}/${kind}`;
  if (!isRecord(body)) {
    fail(at, 'must be an object');
  }
  const unknownKey = Object.keys(body).find(
    (key) => !ENVELOPE_KEYS[kind].includes(key),
  );
  if (unknownKey !== undefined) {
    fail(
      `${at}/${escapeSegment(unknownKey)}`,
      `is not a property ${kind} takes`,
    );
  }
  if (
    typeof body.surfaceId !== 'string' ||
    body.surfaceId.trim().length === 0
  ) {
    fail(`${at}/surfaceId`, 'must be a non-empty string');
  }
  const surfaceId = body.surfaceId;
  switch (kind) {
    case 'createSurface': {
      if (body.dataModel !== undefined && !isRecord(body.dataModel)) {
        fail(`${at}/dataModel`, 'must be an object');
      }
      return {
        kind,
        surfaceId,
        components:
          body.components === undefined
            ? null
            : readComponents(body.components, `${at}/components`),
        dataModel: isRecord(body.dataModel) ? body.dataModel : null,
      };
    }
    case 'updateComponents':
      return {
        kind,
        surfaceId,
        components: readComponents(body.components, `${at}/components`),
      };
    case 'updateDataModel': {
      const path = body.path ?? '/';
      if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) {
        fail(`${at}/path`, 'must be a JSON pointer starting with "/"');
      }
      if (!('value' in body)) {
        fail(`${at}/value`, 'is required (null deletes the value at path)');
      }
      return {
        kind,
        surfaceId,
        path: path === '' ? '/' : path,
        value: body.value,
      };
    }
    case 'deleteSurface':
      return { kind, surfaceId };
    default:
      return fail(at, 'is not a message Geniro reads');
  }
}

export function readA2uiMessages(raw: unknown): A2uiMessagesReading {
  try {
    if (!Array.isArray(raw) || raw.length === 0) {
      fail('/messages', 'must be a non-empty array of A2UI v1.0 messages');
    }
    if (raw.length > MAX_UI_MESSAGES) {
      fail('/messages', `at most ${MAX_UI_MESSAGES} messages per call`);
    }
    const messages = raw.map((entry, index) =>
      readMessage(entry, `/messages/${index}`),
    );
    const surfaceId = messages[0]?.surfaceId ?? '';
    const other = messages.findIndex(
      (message) => message.surfaceId !== surfaceId,
    );
    const stray = messages[other];
    if (stray !== undefined) {
      fail(
        `/messages/${other}/${stray.kind}/surfaceId`,
        `one call draws one surface; this names "${stray.surfaceId}" after "${surfaceId}"`,
      );
    }
    return { ok: true, surfaceId, messages };
  } catch (err) {
    if (err instanceof A2uiError) {
      return { ok: false, error: `${err.pointer}: ${err.message}` };
    }
    throw err;
  }
}

export function a2uiError(pointer: string, reason: string): A2uiError {
  return new A2uiError(pointer, reason);
}

export function isA2uiError(err: unknown): err is A2uiError {
  return err instanceof A2uiError;
}

export function formatA2uiError(err: A2uiError): string {
  return `${err.pointer}: ${err.message}`;
}
