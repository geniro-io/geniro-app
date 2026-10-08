import { createHash } from 'node:crypto';

import { asRecord } from '../../utils/json-util';
import type {
  AgentMcpServerDefinitions,
  AgentMcpServerSpec,
} from '../adapter.types';

/**
 * The CLI-agnostic half of editing a profile's MCP server map — the shape
 * check every CLI's document must pass before geniro writes it, the version a
 * write presents back, and the plain-JSON entry a CLI with no `mcp add` is
 * written. In `adapters/utils/` because it names no CLI: claude, cursor and
 * codex each read and write their own document, and three copies of "what is a
 * server entry" is how one of them comes to accept what another refuses.
 */

/** More servers than this in one profile is a paste gone wrong, not a config. */
export const MAX_MCP_SERVER_DEFINITIONS = 200;

/** A server NAME is a key in the CLI's config and later `mcp login <name>`'s positional. */
export const MAX_MCP_SERVER_NAME_LENGTH = 128;

/** C0 controls and DEL — never part of a name, an argv word or a header. */
// eslint-disable-next-line no-control-regex
export const MCP_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type McpDefinitionsCheck =
  | { ok: true; servers: AgentMcpServerDefinitions }
  | { ok: false; reason: string };

/**
 * Why one server name cannot be used, or null when it can. A leading dash is
 * refused because the name reaches `mcp login <name>` / `mcp add <name>` as a
 * positional, where it would be read as a flag — the rule
 * `cliPositionalArgSchema` states for every other such route.
 */
export function mcpServerNameRefusal(name: string): string | null {
  if (name.trim() === '' || name !== name.trim()) {
    return 'a server name must not be empty or start or end with a space';
  }
  if (name.length > MAX_MCP_SERVER_NAME_LENGTH) {
    return `the server name "${name.slice(0, 40)}…" is longer than ${MAX_MCP_SERVER_NAME_LENGTH} characters`;
  }
  if (MCP_CONTROL_CHARACTER.test(name)) {
    return `the server name "${name}" contains a control character`;
  }
  if (name.startsWith('-')) {
    return `the server name "${name}" must not start with a dash`;
  }
  return null;
}

/**
 * The minimal shape every CLI's server map shares, checked before anything is
 * written: an object of objects, each launching a `command` or reaching a
 * `url`. Deliberately NOT a full schema of any one CLI — the CLI owns its
 * format and validates the rest itself (codex refuses an entry with no
 * transport on write, measured on 0.161.0) — but garbage that every CLI would
 * reject at its next start is refused HERE, before it lands in a file that
 * also holds the user's other servers.
 */
export function checkMcpServerDefinitions(value: unknown): McpDefinitionsCheck {
  const map = asRecord(value);
  if (map === null || Array.isArray(value)) {
    return {
      ok: false,
      reason:
        'the MCP servers must be a JSON object mapping each name to its settings',
    };
  }
  const entries = Object.entries(map);
  if (entries.length > MAX_MCP_SERVER_DEFINITIONS) {
    return {
      ok: false,
      reason: `at most ${MAX_MCP_SERVER_DEFINITIONS} MCP servers`,
    };
  }
  const servers: AgentMcpServerDefinitions = {};
  for (const [name, entry] of entries) {
    const nameRefusal = mcpServerNameRefusal(name);
    if (nameRefusal !== null) {
      return { ok: false, reason: nameRefusal };
    }
    const record = asRecord(entry);
    if (record === null || Array.isArray(entry)) {
      return {
        ok: false,
        reason: `"${name}" must be an object of settings, like {"command": "npx", "args": ["…"]} or {"url": "https://…"}`,
      };
    }
    const command = typeof record.command === 'string' ? record.command : '';
    const url = typeof record.url === 'string' ? record.url : '';
    if (command.trim() === '' && url.trim() === '') {
      return {
        ok: false,
        reason: `"${name}" needs a "command" to launch or a "url" to reach`,
      };
    }
    if (
      record.args !== undefined &&
      !(
        Array.isArray(record.args) &&
        record.args.every((arg) => typeof arg === 'string')
      )
    ) {
      return { ok: false, reason: `"${name}".args must be a list of strings` };
    }
    for (const field of ['env', 'headers', 'http_headers'] as const) {
      const table = record[field];
      if (table === undefined) {
        continue;
      }
      const values = asRecord(table);
      if (
        values === null ||
        Array.isArray(table) ||
        !Object.values(values).every((v) => typeof v === 'string')
      ) {
        return {
          ok: false,
          reason: `"${name}".${field} must be an object of string values`,
        };
      }
    }
    servers[name] = record;
  }
  return { ok: true, servers };
}

/**
 * The version a CLI with no version of its own presents for its server map: a
 * hash of the map as the file holds it. Equal maps are equal versions, so a
 * write whose read-time version no longer matches is a document that moved.
 */
export function mcpServersVersion(servers: AgentMcpServerDefinitions): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(servers)).digest('hex')}`;
}

/**
 * The server map a CLI keeps under one key of its JSON config (`mcpServers`),
 * read STRICTLY: absent is an empty map, anything but an object is a refusal,
 * since a write would replace it.
 */
export function readMcpServersKey(
  config: Record<string, unknown>,
  key: string,
  file: string,
): McpDefinitionsCheck {
  const raw = config[key];
  if (raw === undefined) {
    return { ok: true, servers: {} };
  }
  const map = asRecord(raw);
  if (map === null || Array.isArray(raw)) {
    return {
      ok: false,
      reason: `${file} has an ${key} that is not an object, so geniro will not rewrite it`,
    };
  }
  const servers: AgentMcpServerDefinitions = {};
  for (const [name, entry] of Object.entries(map)) {
    const record = asRecord(entry);
    // An entry that is not an object is still the user's — kept as an empty
    // record would REWRITE it, so the whole map is refused instead.
    if (record === null || Array.isArray(entry)) {
      return {
        ok: false,
        reason: `${file} has an ${key}.${name} that is not an object, so geniro will not rewrite it`,
      };
    }
    servers[name] = record;
  }
  return { ok: true, servers };
}

/**
 * The entry a CLI with NO `mcp add` is written for one server — the shape both
 * claude's and cursor's JSON configs read (`command`/`args`/`env`, or
 * `url`/`headers`). Empty lists are left out, as the CLIs' own writers do.
 */
export function mcpServerJsonEntry(
  spec: AgentMcpServerSpec,
): Record<string, unknown> {
  if (spec.transport === 'http') {
    return {
      url: spec.url ?? '',
      ...(Object.keys(spec.headers).length > 0
        ? { headers: { ...spec.headers } }
        : {}),
    };
  }
  return {
    command: spec.command ?? '',
    ...(spec.args.length > 0 ? { args: [...spec.args] } : {}),
    ...(Object.keys(spec.env).length > 0 ? { env: { ...spec.env } } : {}),
  };
}

/** The sentence every CLI answers a stale document with. */
export const MCP_CONFIG_MOVED_REASON =
  'the MCP servers changed since the editor opened them — reopen it and make the edit again';

/** The sentence every CLI answers a name already in use with. */
export function mcpServerExistsReason(name: string): string {
  return `a server named "${name}" already exists in this profile — edit it in the JSON editor, or pick another name`;
}
