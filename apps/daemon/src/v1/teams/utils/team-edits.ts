/**
 * One change an analysis asks of a team — a PATCH, never the whole file.
 *
 * The tool took the whole edited team once, and that is what made an
 * analysis look hung: a library team runs to 250KB, so a one-paragraph
 * change had the model re-emit every member as tool arguments — measured at
 * 9m42s of generation with nothing on screen, twice in one chat. An edit costs
 * what it changes.
 *
 * - `find`/`replace`: exact text inside one of the team's string values (a
 *   member's role or instructions, a block's text). `find` must occur exactly once across all of
 *   them, the rule an editor's string replace follows, so an edit can never
 *   land somewhere the agent did not read. An optional `path` narrows "all of
 *   them" to the field or the part of the team it names, so a short anchor
 *   unique in one member's instructions does.
 * - `path`/`value`: set one field, adding it if absent.
 * - `path`/`remove`: delete one field, or one array element.
 *
 * A path is `/`-separated keys (`members/reviewer/model`). In an array a
 * segment is an index, the `id` of the element carrying it (`members/reviewer`
 * — a member is named, never counted), or `-` to append when setting.
 */
export type TeamEdit =
  | { find: string; replace: string; path?: string }
  | { path: string; value?: unknown }
  | { path: string; remove: true };

/**
 * The edited team with where each edit landed (the field a `find` changed,
 * the path a set or remove named), or why an edit could not be applied —
 * nothing is half-applied.
 */
export type TeamEditResult =
  | { ok: true; team: unknown; landed: string[] }
  | { ok: false; message: string };

/** How many matching fields an ambiguous `find` names back, at most. */
const MAX_NAMED_MATCHES = 5;

/**
 * Apply `edits` in order, each to the result of the one before, to a COPY of
 * `team`. Validation of the result is the caller's: this only says whether
 * every edit could be carried out as written.
 *
 * `copyFrom` finishes the sentence telling the agent where to copy a `find`
 * that matched nothing — the read it made the edit from.
 */
export function applyTeamEdits(
  team: unknown,
  edits: readonly TeamEdit[],
  copyFrom: string,
): TeamEditResult {
  let doc: unknown = structuredClone(team);
  const landed: string[] = [];
  for (const [index, edit] of edits.entries()) {
    const applied =
      'find' in edit
        ? replaceText(doc, edit, copyFrom)
        : applyAtPath(doc, edit);
    if (typeof applied === 'string') {
      return { ok: false, message: `edit ${index + 1}: ${applied}` };
    }
    doc = applied.doc;
    landed.push(applied.at);
  }
  return { ok: true, team: doc, landed };
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isContainer(value) && !Array.isArray(value);
}

interface StringField {
  path: string[];
  holder: Container;
  key: string | number;
  text: string;
}

/** How a path names one entry: an element by its `id` when it has one, else its index or key. */
function segmentOf(holder: Container, key: string | number): string {
  const value: unknown = Array.isArray(holder)
    ? holder[key as number]
    : holder[key];
  return Array.isArray(holder) &&
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== ''
    ? value.id
    : String(key);
}

/** Every string value in `doc`, with the path that reaches it. */
function stringFields(doc: unknown, path: string[] = []): StringField[] {
  if (!isContainer(doc)) {
    return [];
  }
  const entries: [string | number, unknown][] = Array.isArray(doc)
    ? doc.map((value, index) => [index, value])
    : Object.entries(doc);
  return entries.flatMap(([key, value]) => {
    const at = [...path, segmentOf(doc, key)];
    return typeof value === 'string'
      ? [{ path: at, holder: doc, key, text: value }]
      : stringFields(value, at);
  });
}

/** Every string value in a team with the path an edit names it by — what a search of the team reads. */
export function teamStrings(doc: unknown): { path: string; text: string }[] {
  return stringFields(doc).map((field) => ({
    path: field.path.join('/'),
    text: field.text,
  }));
}

/**
 * The string fields a `find` looks in: every one in the team, or those under
 * the field or part `path` names, addressed as a set or remove addresses one.
 */
function fieldsUnder(
  doc: unknown,
  path: string | undefined,
): { fields: StringField[]; where: string } | string {
  const segments = segmentsOf(path ?? '');
  const reserved = segments.find((segment) => RESERVED_SEGMENTS.has(segment));
  if (reserved !== undefined) {
    return `"${reserved}" cannot be part of a path`;
  }
  let holder: unknown = doc;
  const named: string[] = [];
  for (const [depth, segment] of segments.entries()) {
    const at = segments.slice(0, depth + 1).join('/');
    if (!isContainer(holder)) {
      return `${named.join('/')} is not an object or a list`;
    }
    let key: string | number;
    if (Array.isArray(holder)) {
      key = indexIn(holder, segment);
      if (key < 0 || key >= holder.length) {
        return `no element "${segment}" at ${at}`;
      }
    } else if (Object.hasOwn(holder, segment)) {
      key = segment;
    } else {
      return `nothing at ${at}`;
    }
    const value: unknown = Array.isArray(holder)
      ? holder[key as number]
      : holder[key];
    named.push(segmentOf(holder, key));
    if (typeof value === 'string' && depth === segments.length - 1) {
      return {
        fields: [{ path: named, holder, key, text: value }],
        where: ` under ${named.join('/')}`,
      };
    }
    holder = value;
  }
  return {
    fields: stringFields(holder, named),
    where: named.length === 0 ? ' in the team' : ` under ${named.join('/')}`,
  };
}

function occurrences(text: string, find: string): number {
  let count = 0;
  for (
    let at = text.indexOf(find);
    at !== -1;
    at = text.indexOf(find, at + find.length)
  ) {
    count += 1;
  }
  return count;
}

function replaceText(
  doc: unknown,
  edit: { find: string; replace: string; path?: string },
  copyFrom: string,
): { doc: unknown; at: string } | string {
  if (edit.find === '') {
    return '`find` is empty';
  }
  const scope = fieldsUnder(doc, edit.path);
  if (typeof scope === 'string') {
    return scope;
  }
  const matches = scope.fields
    .map((field) => ({ field, count: occurrences(field.text, edit.find) }))
    .filter((match) => match.count > 0);
  const total = matches.reduce((sum, match) => sum + match.count, 0);
  if (total === 0) {
    return `\`find\` matches no text${scope.where} — copy it exactly from ${copyFrom}`;
  }
  if (total > 1) {
    const where = matches
      .slice(0, MAX_NAMED_MATCHES)
      .map((match) => match.field.path.join('/'))
      .join(', ');
    return `\`find\` matches ${total} places${scope.where} (${where}) — include more of the surrounding text, or narrow \`path\` to one field, so it matches exactly one`;
  }
  const { field } = matches[0]!;
  const replaced = field.text.replace(edit.find, () => edit.replace);
  if (Array.isArray(field.holder)) {
    field.holder[field.key as number] = replaced;
  } else {
    field.holder[field.key] = replaced;
  }
  return { doc, at: field.path.join('/') };
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Names a path may never walk through or write: the model writes the path,
 * and through these an edit would reach what every object in the daemon
 * inherits rather than the team.
 */
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** The array index a segment names: a number, or the `id` of an element. */
function indexIn(array: unknown[], segment: string): number {
  if (/^\d+$/.test(segment)) {
    return Number(segment);
  }
  return array.findIndex(
    (element) => isRecord(element) && element.id === segment,
  );
}

function applyAtPath(
  doc: unknown,
  edit: { path: string; value?: unknown } | { path: string; remove: true },
): { doc: unknown; at: string } | string {
  const segments = segmentsOf(edit.path);
  const reserved = segments.find((segment) => RESERVED_SEGMENTS.has(segment));
  if (reserved !== undefined) {
    return `"${reserved}" cannot be part of a path`;
  }
  const last = segments.pop();
  if (last === undefined) {
    return '`path` names the whole team — name the field to change';
  }
  const removing = 'remove' in edit;
  if (!removing && edit.value === undefined) {
    return '`path` without `value` — give the value to set, or `remove: true`';
  }
  let holder: unknown = doc;
  const named: string[] = [];
  const landed = (name: string) => ({ doc, at: [...named, name].join('/') });
  for (const [depth, segment] of segments.entries()) {
    const at = segments.slice(0, depth + 1).join('/');
    if (Array.isArray(holder)) {
      const index = indexIn(holder, segment);
      if (index < 0 || index >= holder.length) {
        return `no element "${segment}" at ${at}`;
      }
      named.push(segmentOf(holder, index));
      holder = holder[index];
    } else if (isRecord(holder) && Object.hasOwn(holder, segment)) {
      named.push(segment);
      holder = holder[segment];
    } else {
      return `nothing at ${at}`;
    }
    if (!isContainer(holder)) {
      return `${at} is not an object or a list`;
    }
  }
  if (Array.isArray(holder)) {
    if (last === '-') {
      if (removing) {
        return '`-` appends, so it cannot be removed';
      }
      holder.push(edit.value);
      return landed(segmentOf(holder, holder.length - 1));
    }
    const index = indexIn(holder, last);
    if (
      index < 0 ||
      index > holder.length ||
      (removing && index === holder.length)
    ) {
      return `no element "${last}" at ${edit.path}`;
    }
    if (removing) {
      const name = segmentOf(holder, index);
      holder.splice(index, 1);
      return landed(name);
    }
    holder[index] = edit.value;
    return landed(segmentOf(holder, index));
  }
  if (!isRecord(holder)) {
    return `${segments.join('/') || '(root)'} is not an object or a list`;
  }
  if (removing) {
    if (!Object.hasOwn(holder, last)) {
      return `nothing at ${edit.path} to remove`;
    }
    delete holder[last];
  } else {
    holder[last] = edit.value;
  }
  return landed(last);
}
