export type A2uiComponent = {
  id: string;
  component: string;
  [key: string]: unknown;
};

export interface Scope {
  model: unknown;
  base: string;
  index?: number;
}

type ChildRef = { componentId: string; scope: Scope };
type OpenUrlAction = { kind: 'openUrl'; url: string };

const EXPRESSION_OPEN = '$' + '{';
const ESCAPED_EXPRESSION_OPEN = '\\' + EXPRESSION_OPEN;
const LOCALE = 'en-US';
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;
const CALL = /^(@?[A-Za-z_]\w*)\s*\(/;
const NAMED_ARGUMENT = /^([A-Za-z_]\w*)\s*:([\s\S]*)$/;
const QUOTED = /^(['"])([\s\S]*)\1$/;
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_FIELDS = 'EMdyHhmsa';
const REGEX_PATTERN_LIMIT = 512;
const REGEX_VALUE_LIMIT = 4096;
const REGEX_CACHE_LIMIT = 256;
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const regexCache = new Map<string, RegExp | null>();

export function pointerGet(root: unknown, pointer: string): unknown {
  const segments = pointerSegments(pointer);
  if (segments === null) {
    return undefined;
  }
  let current = root;
  for (const segment of segments) {
    current = childOf(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

export function pointerSet(
  root: unknown,
  pointer: string,
  value: unknown,
): unknown {
  const segments = pointerSegments(pointer);
  if (segments === null) {
    return root;
  }
  const [first, ...rest] = segments;
  if (first === undefined) {
    return isAbsent(value) ? undefined : value;
  }
  return setAt(root, first, rest, value);
}

export function overlayDrafts(
  model: unknown,
  drafts: Record<string, unknown>,
): unknown {
  return Object.entries(drafts).reduce<unknown>(
    (next, [pointer, value]) => pointerSet(next, pointer, value),
    model,
  );
}

export function resolvePath(path: string, base: string): string {
  if (path.startsWith('/')) {
    return path;
  }
  if (path === '') {
    return base;
  }
  return (base === '/' ? '' : base) + '/' + path;
}

export function resolveValue(value: unknown, scope: Scope): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => resolveValue(item, scope));
  }
  if (!isRecord(value)) {
    return value;
  }
  const path = value['@path'];
  if (typeof path === 'string') {
    return pointerGet(scope.model, resolvePath(path, scope.base));
  }
  const name = value['@call'];
  if (typeof name === 'string') {
    return callFunction(
      name,
      isRecord(value.args) ? mapRecord(value.args, scope) : {},
      scope,
    );
  }
  return mapRecord(value, scope);
}

export function resolveText(value: unknown, scope: Scope): string {
  return toText(resolveValue(value, scope));
}

export function boundPointer(value: unknown, scope: Scope): string | null {
  const path = isRecord(value) ? value['@path'] : undefined;
  return typeof path === 'string' ? resolvePath(path, scope.base) : null;
}

export function callFunction(
  name: string,
  args: Record<string, unknown>,
  scope: Scope,
): unknown {
  switch (name) {
    case 'required':
      return isPresent(args.value);
    case 'regex':
      return matchesPattern(args.value, args.pattern);
    case 'length':
      return withinRange(
        Array.from(toText(args.value)).length,
        args.min,
        args.max,
      );
    case 'numeric':
      return withinRange(parseNumber(args.value), args.min, args.max);
    case 'email':
      return EMAIL.test(toText(args.value));
    case 'formatString':
      return interpolate(toText(args.value), scope);
    case 'formatNumber':
      return formatNumber(args.value, args.decimals, args.grouping);
    case 'formatCurrency':
      return formatCurrency(
        args.value,
        args.currency,
        args.decimals,
        args.grouping,
      );
    case 'formatDate':
      return formatDate(args.value, args.format);
    case 'pluralize':
      return pluralize(args);
    case 'openUrl':
      return openUrl(args.url);
    case 'and':
      return (
        Array.isArray(args.values) &&
        args.values.every((item: unknown) => toBoolean(item))
      );
    case 'or':
      return (
        Array.isArray(args.values) &&
        args.values.some((item: unknown) => toBoolean(item))
      );
    case 'not':
      return !toBoolean(args.value);
    case '@index':
      return scope.index === undefined
        ? undefined
        : scope.index + offsetOf(args.offset);
    default:
      return undefined;
  }
}

export function checkMessages(
  component: A2uiComponent,
  scope: Scope,
): string[] {
  const rules = component['@checks'];
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.flatMap((rule: unknown) => {
    if (!isRecord(rule)) {
      return [];
    }
    const outcome = resolveValue(rule.condition, scope);
    if (toBoolean(outcome)) {
      return [];
    }
    const fallback =
      typeof rule.message === 'string' ? rule.message : 'Invalid value';
    return [validationMessage(outcome) ?? fallback];
  });
}

export function templateChildren(children: unknown, scope: Scope): ChildRef[] {
  if (Array.isArray(children)) {
    return children.flatMap((componentId: unknown) =>
      typeof componentId === 'string' ? [{ componentId, scope }] : [],
    );
  }
  if (!isRecord(children)) {
    return [];
  }
  const { componentId, path } = children;
  if (typeof componentId !== 'string' || typeof path !== 'string') {
    return [];
  }
  const pointer = resolvePath(path, scope.base);
  const collection = pointerGet(scope.model, pointer);
  const keys = Array.isArray(collection)
    ? collection.map((_item: unknown, index: number) => String(index))
    : isRecord(collection)
      ? Object.keys(collection)
      : [];
  return keys.map((key, index) => ({
    componentId,
    scope: { model: scope.model, base: joinPointer(pointer, key), index },
  }));
}

export function isOneShot(component: A2uiComponent): boolean {
  const metadata = component['@metadata'];
  const extensions = isRecord(metadata) ? metadata.extensions : undefined;
  return isRecord(extensions) && extensions.geniroOneShot === true;
}

function pointerSegments(pointer: string): string[] | null {
  if (pointer === '' || pointer === '/') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    return null;
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function joinPointer(parent: string, segment: string): string {
  return (parent === '/' ? '' : parent) + '/' + escapeSegment(segment);
}

function childOf(container: unknown, segment: string): unknown {
  if (Array.isArray(container)) {
    const index = arrayIndex(segment);
    return index !== null && index < container.length
      ? container[index]
      : undefined;
  }
  if (
    isRecord(container) &&
    Object.prototype.hasOwnProperty.call(container, segment)
  ) {
    return container[segment];
  }
  return undefined;
}

function arrayIndex(segment: string): number | null {
  return ARRAY_INDEX.test(segment) ? Number(segment) : null;
}

function setAt(
  container: unknown,
  segment: string,
  rest: string[],
  value: unknown,
): unknown {
  const current = childOf(container, segment);
  const [next, ...tail] = rest;
  if (next === undefined) {
    return withChild(container, segment, value);
  }
  if (isAbsent(current) && isAbsent(value)) {
    return container;
  }
  return withChild(
    container,
    segment,
    setAt(isAbsent(current) ? emptyFor(next) : current, next, tail, value),
  );
}

function withChild(
  container: unknown,
  segment: string,
  next: unknown,
): unknown {
  if (Array.isArray(container)) {
    return withItem(container, segment, next);
  }
  if (!isRecord(container)) {
    return isAbsent(next)
      ? container
      : withChild(emptyFor(segment), segment, next);
  }
  if (!isAbsent(next)) {
    return { ...container, [segment]: next };
  }
  if (!Object.prototype.hasOwnProperty.call(container, segment)) {
    return container;
  }
  const copy = { ...container };
  delete copy[segment];
  return copy;
}

function withItem(items: unknown[], segment: string, next: unknown): unknown[] {
  const index = segment === '-' ? items.length : arrayIndex(segment);
  if (index === null || index > items.length) {
    return items;
  }
  if (isAbsent(next)) {
    return index < items.length
      ? items.filter((_item, position) => position !== index)
      : items;
  }
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

function emptyFor(segment: string): unknown[] | Record<string, unknown> {
  return segment === '-' || arrayIndex(segment) !== null ? [] : {};
}

function mapRecord(
  record: Record<string, unknown>,
  scope: Scope,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      resolveValue(item, scope),
    ]),
  );
}

function validationMessage(outcome: unknown): string | undefined {
  if (!isRecord(outcome) || typeof outcome.message !== 'string') {
    return undefined;
  }
  return outcome.message;
}

function interpolate(template: string, scope: Scope): string {
  let text = '';
  let index = 0;
  while (index < template.length) {
    if (template.startsWith(ESCAPED_EXPRESSION_OPEN, index)) {
      text += EXPRESSION_OPEN;
      index += ESCAPED_EXPRESSION_OPEN.length;
      continue;
    }
    const close = template.startsWith(EXPRESSION_OPEN, index)
      ? matchingClose(template, index + 1, '{', '}')
      : -1;
    if (close !== -1) {
      text += toText(
        evaluateExpression(
          template.slice(index + EXPRESSION_OPEN.length, close),
          scope,
        ),
      );
      index = close + 1;
      continue;
    }
    text += template.charAt(index);
    index += 1;
  }
  return text;
}

function evaluateExpression(source: string, scope: Scope): unknown {
  const text = source.trim();
  if (text === '') {
    return undefined;
  }
  if (
    text.startsWith(EXPRESSION_OPEN) &&
    matchingClose(text, 1, '{', '}') === text.length - 1
  ) {
    return evaluateExpression(text.slice(EXPRESSION_OPEN.length, -1), scope);
  }
  const call = CALL.exec(text);
  if (
    call !== null &&
    text.endsWith(')') &&
    matchingClose(text, call[0].length - 1, '(', ')') === text.length - 1
  ) {
    return callFunction(
      call[1] ?? '',
      parseArguments(text.slice(call[0].length, -1), scope),
      scope,
    );
  }
  const quoted = QUOTED.exec(text);
  if (quoted !== null) {
    return quoted[2];
  }
  if (NUMBER_LITERAL.test(text)) {
    return Number(text);
  }
  if (text === 'true' || text === 'false') {
    return text === 'true';
  }
  if (text === 'null') {
    return null;
  }
  return pointerGet(scope.model, resolvePath(text, scope.base));
}

function parseArguments(source: string, scope: Scope): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const part of splitTopLevel(source)) {
    const named = NAMED_ARGUMENT.exec(part.trim());
    if (named !== null) {
      entries.push([named[1] ?? '', evaluateExpression(named[2] ?? '', scope)]);
    }
  }
  return Object.fromEntries(entries);
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function matchingClose(
  source: string,
  open: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function matchesPattern(value: unknown, pattern: unknown): boolean {
  if (typeof pattern !== 'string' || pattern.length > REGEX_PATTERN_LIMIT) {
    return false;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }
  const text = String(value);
  if (Array.from(text).length > REGEX_VALUE_LIMIT) {
    return false;
  }
  return compiledPattern(pattern)?.test(text) ?? false;
}

function compiledPattern(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = compilePattern(pattern);
  if (regexCache.size >= REGEX_CACHE_LIMIT) {
    regexCache.clear();
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

function withinRange(amount: number, min: unknown, max: unknown): boolean {
  if (!Number.isFinite(amount)) {
    return false;
  }
  const low = parseNumber(min);
  const high = parseNumber(max);
  return (
    (!Number.isFinite(low) || amount >= low) &&
    (!Number.isFinite(high) || amount <= high)
  );
}

function formatNumber(
  value: unknown,
  decimals: unknown,
  grouping: unknown,
): string {
  const amount = parseNumber(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat(LOCALE, numberOptions(decimals, grouping)).format(
        amount,
      )
    : '';
}

function formatCurrency(
  value: unknown,
  currency: unknown,
  decimals: unknown,
  grouping: unknown,
): string {
  const amount = parseNumber(value);
  if (
    !Number.isFinite(amount) ||
    typeof currency !== 'string' ||
    !CURRENCY_CODE.test(currency)
  ) {
    return '';
  }
  return new Intl.NumberFormat(LOCALE, {
    ...numberOptions(decimals, grouping),
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount);
}

function numberOptions(
  decimals: unknown,
  grouping: unknown,
): Intl.NumberFormatOptions {
  const digits = parseNumber(decimals);
  const options: Intl.NumberFormatOptions = {
    useGrouping: isAbsent(grouping) ? true : toBoolean(grouping),
  };
  if (Number.isInteger(digits) && digits >= 0 && digits <= 20) {
    options.minimumFractionDigits = digits;
    options.maximumFractionDigits = digits;
  }
  return options;
}

function formatDate(value: unknown, format: unknown): string {
  const date = toDate(value);
  return date === null ? '' : formatDatePattern(date, toText(format));
}

function toDate(value: unknown): Date | null {
  const time =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(time) ? new Date(time) : null;
}

function formatDatePattern(date: Date, pattern: string): string {
  let text = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "'") {
      const close = pattern.indexOf("'", index + 1);
      if (close === index + 1) {
        text += "'";
        index += 2;
      } else if (close === -1) {
        text += pattern.slice(index + 1);
        index = pattern.length;
      } else {
        text += pattern.slice(index + 1, close);
        index = close + 1;
      }
      continue;
    }
    if (DATE_FIELDS.includes(char)) {
      let end = index;
      while (end < pattern.length && pattern.charAt(end) === char) {
        end += 1;
      }
      text += formatDateField(date, char, end - index);
      index = end;
      continue;
    }
    text += char;
    index += 1;
  }
  return text;
}

function formatDateField(date: Date, field: string, width: number): string {
  const hours = date.getHours();
  switch (field) {
    case 'E': {
      const name = WEEKDAYS[date.getDay()] ?? '';
      return width >= 4 ? name : name.slice(0, 3);
    }
    case 'M': {
      const name = MONTHS[date.getMonth()] ?? '';
      if (width >= 4) {
        return name;
      }
      if (width === 3) {
        return name.slice(0, 3);
      }
      return padNumber(date.getMonth() + 1, width);
    }
    case 'd':
      return padNumber(date.getDate(), width);
    case 'y':
      return padNumber(
        width === 2 ? date.getFullYear() % 100 : date.getFullYear(),
        width,
      );
    case 'H':
      return padNumber(hours, width);
    case 'h':
      return padNumber(hours % 12 || 12, width);
    case 'm':
      return padNumber(date.getMinutes(), width);
    case 's':
      return padNumber(date.getSeconds(), width);
    case 'a':
      return hours < 12 ? 'AM' : 'PM';
    default:
      return '';
  }
}

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function pluralize(args: Record<string, unknown>): string {
  const count = parseNumber(args.value);
  const category = Number.isFinite(count)
    ? new Intl.PluralRules(LOCALE).select(count)
    : 'other';
  return toText(args[category] ?? args.other);
}

function openUrl(url: unknown): OpenUrlAction | undefined {
  if (typeof url !== 'string' || !URL.canParse(url)) {
    return undefined;
  }
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    ? { kind: 'openUrl', url: parsed.href }
    : undefined;
}

function offsetOf(offset: unknown): number {
  const amount = parseNumber(offset);
  return Number.isFinite(amount) ? amount : 0;
}

function isPresent(value: unknown): boolean {
  if (isAbsent(value) || value === '') {
    return false;
  }
  return !(Array.isArray(value) && value.length === 0);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0 && !Number.isNaN(value);
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  if (isRecord(value) && typeof value.valid === 'boolean') {
    return value.valid;
  }
  return false;
}

function toText(value: unknown): string {
  if (isAbsent(value)) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => toText(item)).join(', ');
  }
  return JSON.stringify(value);
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return Number.NaN;
}

function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
