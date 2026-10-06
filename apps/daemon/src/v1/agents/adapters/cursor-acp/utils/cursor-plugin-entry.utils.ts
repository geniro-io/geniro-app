import { asRecord } from '../../../utils/json-util';
import type {
  AgentMcpPluginServer,
  AgentMcpPluginVariable,
} from '../../adapter.types';
import {
  CURSOR_PLUGIN_TEXT_MAX_CHARS,
  CURSOR_SECRET_VARIABLE_NAME,
} from '../cursor-acp.const';

/**
 * A plugin's MCP server config turned into an entry `~/.cursor/mcp.json` can
 * hold — the plugin's own `${…}` variables filled in, because nothing will
 * fill them once the entry is no longer a plugin's.
 */

/** What a copy writes, or why it cannot be written. */
export type PluginEntryResult =
  { ok: true; entry: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Keys holding name→value maps where an entry that cannot resolve is DROPPED
 * rather than refused: it is the credential a user chose not to give, and
 * leaving the header out is what makes the server ask them to sign in instead.
 */
const DROPPABLE_MAP_KEYS: readonly string[] = ['headers', 'env'];

/**
 * Keys whose values are SENT to the plugin's host. No `${env:…}` survives in
 * them whatever its name — a name list cannot tell `DATABASE_URL` or `DB_PASS`
 * from a harmless setting, and the CLI would read the user's own environment
 * into a request to somebody else's server. The name check is left to the keys
 * that only feed a local process (`env`, `command`, `args`).
 */
const REMOTE_KEYS: readonly string[] = ['url', 'headers'];

/** One `${…}` the CLI would expand, where it sits in its string. */
export interface VariableRef {
  start: number;
  /** Exclusive — just past the closing `}`. */
  end: number;
  /** Set for `${env:NAME}`, which the CLI reads from its own environment. */
  env: string | null;
  /** Set for `${NAME}` and `${NAME:-default}`. */
  name: string | null;
  fallback: string | null;
}

function isEnvNameChar(code: number, first: boolean): boolean {
  const letter =
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
  return first ? letter : letter || (code >= 48 && code <= 57);
}

/**
 * Every `${…}` in `text`, matched exactly as `CURSOR_VARIABLE_PATTERN_SOURCE`
 * matches them, by a scan that is linear in the text. The pattern itself is not
 * run: it backtracks quadratically on a run of `${`, and these strings are a
 * plugin's own text, read on every listing.
 *
 * Linear because every arm of the pattern ends at the FIRST `}` after its `${`
 * (`[^:}]` and `[^}]` exclude it), so every attempt inside one span shares
 * that `}` — and the first `:` after it — and neither is searched for again.
 */
export function scanVariables(text: string): VariableRef[] {
  const refs: VariableRef[] = [];
  let close = -1;
  // -2 = not searched yet; -1 = none anywhere after the last search, so none
  // after any later start either.
  let colon = -2;
  let from = 0;
  for (;;) {
    const start = text.indexOf('${', from);
    if (start === -1) {
      return refs;
    }
    const body = start + 2;
    if (close < body) {
      close = text.indexOf('}', body);
      if (close === -1) {
        return refs;
      }
    }
    if (colon === -2 || (colon !== -1 && colon < body)) {
      colon = text.indexOf(':', body);
    }
    const ref = readVariable(text, start, body, close, colon);
    if (ref === null) {
      from = start + 1;
      continue;
    }
    refs.push(ref);
    from = close + 1;
  }
}

/** The variable `${` at `start` opens, or null when the pattern matches nothing there. */
function readVariable(
  text: string,
  start: number,
  body: number,
  close: number,
  colon: number,
): VariableRef | null {
  if (text.startsWith('env:', body) && body + 4 < close) {
    let at = body + 4;
    while (at < close && isEnvNameChar(text.charCodeAt(at), at === body + 4)) {
      at += 1;
    }
    if (at === close) {
      const env = text.slice(body + 4, close);
      return { start, end: close + 1, env, name: null, fallback: null };
    }
  }
  if (colon === -1 || colon > close) {
    return close > body
      ? {
          start,
          end: close + 1,
          env: null,
          name: text.slice(body, close),
          fallback: null,
        }
      : null;
  }
  if (colon === body || text.charCodeAt(colon + 1) !== 45 /* - */) {
    return null;
  }
  return {
    start,
    end: close + 1,
    env: null,
    name: text.slice(body, colon),
    fallback: text.slice(colon + 2, close),
  };
}

/**
 * `text` with every `${NAME}` / `${NAME:-default}` filled from `values`, plus
 * what the FILLED text still asks the CLI's own environment for: the names
 * nothing filled, and the `${env:NAME}` it reads. Those are read off the
 * result rather than the source, because a default can carry one of its own
 * (`${A:-${env:TOKEN}}` fills to `${env:TOKEN}`). `${env:NAME}` is left as
 * written — still valid in `mcp.json`, where the CLI reads it itself.
 */
export function substituteVariables(
  text: string,
  values: Readonly<Record<string, string>>,
): { text: string; unresolved: string[]; env: string[] } {
  let out = '';
  let at = 0;
  for (const ref of scanVariables(text)) {
    out += text.slice(at, ref.start);
    at = ref.end;
    // Own keys only: a template naming `${constructor}` must not be filled
    // from the object's prototype.
    const value =
      ref.name !== null && Object.hasOwn(values, ref.name)
        ? values[ref.name]
        : undefined;
    if (value !== undefined && value !== '') {
      out += value;
    } else if (ref.name !== null && ref.fallback !== null) {
      out += ref.fallback;
    } else {
      out += text.slice(ref.start, ref.end);
    }
  }
  out += text.slice(at);
  const unresolved: string[] = [];
  const env: string[] = [];
  for (const ref of scanVariables(out)) {
    if (ref.env !== null) {
      env.push(ref.env);
    } else if (ref.name !== null) {
      unresolved.push(ref.name);
    }
  }
  return { text: out, unresolved, env };
}

/**
 * The entry a copy writes — every string in the config filled in. Refused
 * when anything still needs a variable nobody supplied, except inside
 * `headers` and `env`, where that entry is left out instead. A copy carries
 * no credential: a value bound for the plugin's host that reads ANY variable
 * from the CLI's own environment is left out of `headers` and refused in
 * `url`, and one feeding the local process that reads a secret-named variable
 * is left out of `env` and refused anywhere else.
 */
export function buildPluginServerEntry(
  config: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, string>>,
): PluginEntryResult {
  const missing = new Set<string>();
  const secrets = new Set<string>();
  const sent = new Set<string>();
  let tooLong = false;
  /** Whether a filled value reads something from the environment it may not. */
  const readsForbidden = (env: readonly string[], remote: boolean): boolean =>
    remote
      ? env.length > 0
      : env.some((name) => CURSOR_SECRET_VARIABLE_NAME.test(name));
  const walk = (value: unknown, remote: boolean): unknown => {
    if (typeof value === 'string') {
      if (value.length > CURSOR_PLUGIN_TEXT_MAX_CHARS) {
        tooLong = true;
        return value;
      }
      const filled = substituteVariables(value, values);
      filled.unresolved.forEach((name) => missing.add(name));
      if (readsForbidden(filled.env, remote)) {
        filled.env.forEach((name) => (remote ? sent : secrets).add(name));
      }
      return filled.text;
    }
    if (Array.isArray(value)) {
      return value.map((inner) => walk(inner, remote));
    }
    const record = asRecord(value);
    return record === null
      ? value
      : Object.fromEntries(
          Object.entries(record).map(([key, inner]) => [
            key,
            walk(inner, remote),
          ]),
        );
  };

  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const remote = REMOTE_KEYS.includes(key);
    const map = DROPPABLE_MAP_KEYS.includes(key) ? asRecord(value) : null;
    if (map === null) {
      entry[key] = walk(value, remote);
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(map)) {
      if (typeof raw !== 'string') {
        kept[name] = walk(raw, remote);
        continue;
      }
      if (raw.length > CURSOR_PLUGIN_TEXT_MAX_CHARS) {
        continue;
      }
      const filled = substituteVariables(raw, values);
      if (
        filled.unresolved.length === 0 &&
        filled.text.trim() !== '' &&
        !readsForbidden(filled.env, remote)
      ) {
        kept[name] = filled.text;
      }
    }
    if (Object.keys(kept).length > 0) {
      entry[key] = kept;
    }
  }
  if (tooLong) {
    return {
      ok: false,
      reason: 'this server’s config holds a value too long to read',
    };
  }
  if (sent.size > 0) {
    return {
      ok: false,
      reason: `this server would send ${[...sent].sort().join(', ')} from your environment to its own host, and a copy carries no credential`,
    };
  }
  if (secrets.size > 0) {
    return {
      ok: false,
      reason: `this server reads ${[...secrets].sort().join(', ')} from your environment, and a copy carries no credential`,
    };
  }
  if (missing.size > 0) {
    return {
      ok: false,
      reason: `this server needs ${[...missing].sort().join(', ')}, which has no value`,
    };
  }
  return { ok: true, entry };
}

/**
 * Whether `value` is something `template` could have expanded to — each
 * variable standing for a non-empty run with no `/` in it, so a variable is a
 * host or a path SEGMENT and `https://${HOST}/v1/mcp` does not claim every
 * server whose URL merely ends the same way. A template with no variables
 * matches only itself; one that is nothing but variables matches nothing.
 *
 * A linear scan, never a regex built from the template: the template is a
 * plugin's own text, and `.+.+.+…` from a run of adjacent variables
 * backtracks for seconds against every URL in the user's config.
 */
export function templateMatches(template: string, value: string): boolean {
  if (
    template.length > CURSOR_PLUGIN_TEXT_MAX_CHARS ||
    value.length > CURSOR_PLUGIN_TEXT_MAX_CHARS
  ) {
    return false;
  }
  const literals: string[] = [];
  let literalStart = 0;
  for (const ref of scanVariables(template)) {
    literals.push(template.slice(literalStart, ref.start));
    literalStart = ref.end;
  }
  literals.push(template.slice(literalStart));
  if (literals.every((literal) => literal === '')) {
    return false;
  }
  const first = literals[0] ?? '';
  if (literals.length === 1) {
    return value === first;
  }
  const last = literals[literals.length - 1] ?? '';
  if (!value.startsWith(first) || !value.endsWith(last)) {
    return false;
  }
  // Leftmost placement gives every later literal the most room and every
  // variable the shortest run, so it cannot miss a match a later one finds.
  let at = first.length;
  for (const literal of literals.slice(1, -1)) {
    const found = value.indexOf(literal, at + 1);
    if (found === -1 || value.slice(at, found).includes('/')) {
      return false;
    }
    at = found + literal.length;
  }
  const end = value.length - last.length;
  return end >= at + 1 && !value.slice(at, end).includes('/');
}

/** The host of a URL (or URL template): between `://` and the next `/`. */
function hostOf(url: string): string {
  const scheme = url.indexOf('://');
  const from = scheme === -1 ? 0 : scheme + 3;
  const slash = url.indexOf('/', from);
  return url.slice(from, slash === -1 ? undefined : slash);
}

/** How many host spellings a template may expand to before matching gives up. */
const MAX_TEMPLATE_HOSTS = 64;

/**
 * Whether `url` sits on a host `template` names — its literal host, or one of
 * the declared values of the variables written there. A host variable with no
 * declared values claims nothing: `https://${HOST}/mcp` would otherwise match
 * every server on the commonest MCP path, marking an unrelated entry as this
 * plugin's copy.
 */
export function templateHostMatches(
  template: string,
  url: string,
  variables: readonly AgentMcpPluginVariable[],
): boolean {
  const host = hostOf(template);
  let spellings: Record<string, string>[] = [{}];
  for (const ref of scanVariables(host)) {
    const options =
      ref.name === null
        ? null
        : (variables.find((variable) => variable.name === ref.name)?.options ??
          null);
    if (ref.name === null || options === null) {
      return false;
    }
    const name = ref.name;
    spellings = spellings.flatMap((values) =>
      options.map((option) => ({ ...values, [name]: option })),
    );
    if (spellings.length > MAX_TEMPLATE_HOSTS) {
      return false;
    }
  }
  const wanted = hostOf(url);
  return spellings.some(
    (values) => substituteVariables(host, values).text === wanted,
  );
}

/** How a plugin server is reached, as far as its config says. */
export function pluginServerTarget(
  config: Readonly<Record<string, unknown>>,
): Pick<AgentMcpPluginServer, 'transport' | 'target'> {
  const url = typeof config.url === 'string' ? config.url : null;
  if (url !== null) {
    return { transport: config.type === 'sse' ? 'sse' : 'http', target: url };
  }
  if (typeof config.command === 'string') {
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    return {
      transport: 'stdio',
      target: [config.command, ...args].join(' '),
    };
  }
  return { transport: null, target: null };
}

/**
 * The values a copy substitutes: what the user gave for each declared
 * variable, its default otherwise. Refused for a name the plugin does not
 * declare (which is also how a secret is refused — none is ever declared to
 * the panel), a value outside a declared list, a control character, or a
 * required variable left with nothing.
 */
export function pluginVariableValues(
  declared: readonly AgentMcpPluginVariable[],
  given: Readonly<Record<string, string>>,
):
  { ok: true; values: Record<string, string> } | { ok: false; reason: string } {
  const byName = new Map(declared.map((variable) => [variable.name, variable]));
  for (const name of Object.keys(given)) {
    if (!byName.has(name)) {
      return {
        ok: false,
        reason: `${name} is not a variable this plugin asks for`,
      };
    }
  }
  const values: Record<string, string> = {};
  for (const variable of declared) {
    const typed = Object.hasOwn(given, variable.name)
      ? given[variable.name]
      : undefined;
    const value = (typed ?? '').trim() || variable.defaultValue || '';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      return {
        ok: false,
        reason: `${variable.name} contains a control character`,
      };
    }
    // The CLI expands `${…}` in mcp.json from its OWN environment, so a value
    // carrying one would make the copy read whatever that names — a key the
    // user exported included — into a URL or header bound for another host.
    if (value.includes('${')) {
      return { ok: false, reason: `${variable.name} cannot contain \${` };
    }
    if (value === '') {
      if (variable.required) {
        return {
          ok: false,
          reason: `${variable.title ?? variable.name} is required`,
        };
      }
      continue;
    }
    if (variable.options !== null && !variable.options.includes(value)) {
      return {
        ok: false,
        reason: `${value} is not one of the values ${variable.title ?? variable.name} allows`,
      };
    }
    values[variable.name] = value;
  }
  return { ok: true, values };
}

/**
 * Every `${NAME}` a server config uses with no default — the names a copy
 * cannot fill unless somebody gives a value. `${env:…}` is the CLI's own to
 * read and is left out.
 */
export function referencedVariables(
  config: Readonly<Record<string, unknown>>,
): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length > CURSOR_PLUGIN_TEXT_MAX_CHARS) {
        return;
      }
      for (const ref of scanVariables(value)) {
        if (ref.name !== null && ref.fallback === null) {
          names.add(ref.name);
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  visit(config);
  return [...names];
}
