import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

import { asRecord, payloadString } from '../../../utils/json-util';
import type {
  AgentMcpPlugin,
  AgentMcpPluginVariable,
} from '../../adapter.types';
import { readDirSafe, readFileSafe } from '../../utils/fs-safe.utils';
import {
  CURSOR_HOME_DIR_NAME,
  CURSOR_PLUGIN_CACHE_COMPLETE_MARKER,
  CURSOR_PLUGIN_CACHE_DIR_NAME,
  CURSOR_PLUGIN_DEFAULT_MCP_FILES,
  CURSOR_PLUGIN_FILE_MAX_BYTES,
  CURSOR_PLUGIN_LOCAL_DIR_NAME,
  CURSOR_PLUGIN_MANIFEST_PATHS,
  CURSOR_PLUGIN_ROOT_VARIABLES,
  CURSOR_PLUGIN_SERVER_ID_PREFIX,
  CURSOR_PLUGINS_DIR_NAME,
  CURSOR_SECRET_VARIABLE_NAME,
  CURSOR_SETTINGS_FILE_NAME,
} from '../cursor-acp.const';
import {
  cursorProjectRoot,
  parseJsonObject,
  parseMcpServers,
} from './cursor-mcp-scope.utils';
import {
  pluginServerTarget,
  referencedVariables,
  templateHostMatches,
  templateMatches,
} from './cursor-plugin-entry.utils';

/**
 * Cursor's installed plugins, read off its own files.
 *
 * Read-only and best-effort throughout, on the rule the MCP scope reader
 * follows: these are the user's files, and one that is missing, unreadable or
 * malformed costs that plugin its row — never the listing it rides on.
 */

/** One server a plugin declares, with the config a copy is built from. */
export interface CursorPluginServer {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** One installed plugin, with what a copy needs beyond the listed facts. */
export interface CursorPlugin {
  readonly name: string;
  /** The plugin's own directory — what `${CURSOR_PLUGIN_ROOT}` expands to. */
  readonly dir: string;
  readonly enabledHere: boolean | null;
  readonly servers: readonly CursorPluginServer[];
  readonly variables: AgentMcpPluginVariable[];
}

/** What a manifest says, before its server pointer has been followed. */
interface PluginManifest {
  readonly name: string | null;
  readonly servers:
    | { readonly kind: 'pointer'; readonly path: string }
    | { readonly kind: 'inline'; readonly servers: Record<string, unknown> }
    | null;
  readonly variables: AgentMcpPluginVariable[];
}

/**
 * The variables a manifest declares, secrets left out.
 *
 * The manifest's `variables` is a JSON schema (`properties` + `required`), the
 * shape Cursor's plugin reference documents.
 */
export function parsePluginVariables(
  schema: unknown,
): AgentMcpPluginVariable[] {
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  if (properties === null) {
    return [];
  }
  const required = new Set(
    Array.isArray(root?.required)
      ? root.required.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  );
  const variables: AgentMcpPluginVariable[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw) ?? {};
    if (
      property.writeOnly === true ||
      property.format === 'password' ||
      CURSOR_SECRET_VARIABLE_NAME.test(name)
    ) {
      continue;
    }
    const options = Array.isArray(property.enum)
      ? property.enum.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
    variables.push({
      name,
      title: payloadString(property, 'title'),
      description: payloadString(property, 'description'),
      options: options.length > 0 ? options : null,
      required: required.has(name),
      defaultValue: payloadString(property, 'default'),
    });
  }
  return variables;
}

/** A manifest's name, server source and variables, or null when it is not a manifest. */
export function parsePluginManifest(
  source: string | null,
): PluginManifest | null {
  const manifest = parseJsonObject(source);
  if (manifest === null) {
    return null;
  }
  const pointer = payloadString(manifest, 'mcpServers');
  const inline = asRecord(manifest.mcpServers);
  return {
    name: payloadString(manifest, 'name'),
    servers:
      pointer !== null
        ? { kind: 'pointer', path: pointer }
        : inline !== null
          ? { kind: 'inline', servers: inline }
          : null,
    variables: parsePluginVariables(manifest.variables),
  };
}

/** The servers under `mcpServers` whose config is an object, in file order. */
export function pluginServersOf(
  servers: Record<string, unknown> | null,
): CursorPluginServer[] {
  if (servers === null) {
    return [];
  }
  const out: CursorPluginServer[] = [];
  for (const [name, config] of Object.entries(servers)) {
    const object = asRecord(config);
    if (object !== null) {
      out.push({ name, config: object });
    }
  }
  return out;
}

/**
 * Which plugins a project's `.cursor/settings.json` switches on or off, by name.
 * Absent from the map means the file says nothing about it.
 */
export function parseProjectPluginStates(
  source: string | null,
): Map<string, boolean> {
  const states = new Map<string, boolean>();
  const plugins = asRecord(parseJsonObject(source)?.plugins);
  for (const [name, raw] of Object.entries(plugins ?? {})) {
    const enabled = asRecord(raw)?.enabled;
    if (typeof enabled === 'boolean') {
      states.set(name, enabled);
    }
  }
  return states;
}

/** The identifier cursor's app files a plugin's server under. */
export function pluginServerId(plugin: string, server: string): string {
  return `${CURSOR_PLUGIN_SERVER_ID_PREFIX}-${plugin}-${server}`;
}

async function isDirectory(path: string): Promise<boolean> {
  // `stat`, not the dirent: a `local/` plugin is commonly a symlink to a
  // checkout, and a dirent reports the link rather than what it points at.
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readDirSafe(dir);
  const paths = entries.map((entry) => join(dir, entry.name));
  const flags = await Promise.all(paths.map(isDirectory));
  return paths.filter((_path, index) => flags[index]);
}

/**
 * The installed version of one cached plugin: the complete version directory
 * written last, since a plugin updated in place leaves its older one behind.
 */
async function completeVersion(pluginDir: string): Promise<string | null> {
  const versions = await subdirectories(pluginDir);
  const markers = await Promise.all(
    versions.map((dir) =>
      stat(join(dir, CURSOR_PLUGIN_CACHE_COMPLETE_MARKER)).catch(() => null),
    ),
  );
  let best: { dir: string; at: number } | null = null;
  for (let index = 0; index < versions.length; index += 1) {
    const marker = markers[index];
    const dir = versions[index];
    if (marker && dir && (best === null || marker.mtimeMs > best.at)) {
      best = { dir, at: marker.mtimeMs };
    }
  }
  return best?.dir ?? null;
}

/** Every plugin root on this machine, marketplace installs first. */
async function pluginRoots(
  cursorHome: string,
): Promise<{ dir: string; fallbackName: string }[]> {
  const plugins = join(cursorHome, CURSOR_PLUGINS_DIR_NAME);
  const pluginDirs = (
    await Promise.all(
      (await subdirectories(join(plugins, CURSOR_PLUGIN_CACHE_DIR_NAME))).map(
        subdirectories,
      ),
    )
  ).flat();
  const versions = await Promise.all(pluginDirs.map(completeVersion));
  const cached = pluginDirs.flatMap((pluginDir, index) => {
    const version = versions[index];
    return version ? [{ dir: version, fallbackName: basename(pluginDir) }] : [];
  });
  const local = (
    await subdirectories(join(plugins, CURSOR_PLUGIN_LOCAL_DIR_NAME))
  ).map((dir) => ({ dir, fallbackName: basename(dir) }));
  return [...cached, ...local];
}

/**
 * One file of a plugin, read only if it really lies inside the plugin's own
 * directory and is small enough to be a config — or null.
 *
 * Every file a plugin ships goes through here: its manifest, its default MCP
 * files and whatever its manifest points at. They are somebody else's text,
 * and neither a `../` pointer nor a symlink checked into the plugin may turn
 * this reader into one of the user's own files, so containment is judged on
 * REAL paths. The size cap keeps a huge file away from the variable pattern.
 */
async function readPluginFile(
  pluginDir: string,
  path: string,
): Promise<string | null> {
  const [root, target] = await Promise.all([
    realpath(pluginDir).catch(() => null),
    realpath(resolve(pluginDir, path)).catch(() => null),
  ]);
  if (root === null || target === null) {
    return null;
  }
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || inside.startsWith(sep)) {
    return null;
  }
  const info = await stat(target).catch(() => null);
  if (
    info === null ||
    !info.isFile() ||
    info.size > CURSOR_PLUGIN_FILE_MAX_BYTES
  ) {
    return null;
  }
  return readFile(target, 'utf8').catch(() => null);
}

/**
 * A variable the servers use that the manifest never declared, offered as an
 * optional field so the copy can still be made. Never a secret.
 */
function inferredVariables(
  servers: readonly CursorPluginServer[],
  declared: readonly AgentMcpPluginVariable[],
): AgentMcpPluginVariable[] {
  const known = new Set([
    ...declared.map((variable) => variable.name),
    ...CURSOR_PLUGIN_ROOT_VARIABLES,
  ]);
  const names = new Set(
    servers.flatMap((server) => referencedVariables(server.config)),
  );
  return [...names]
    .filter(
      (name) => !known.has(name) && !CURSOR_SECRET_VARIABLE_NAME.test(name),
    )
    .map((name) => ({
      name,
      title: null,
      description: null,
      options: null,
      required: false,
      defaultValue: null,
    }));
}

async function readPlugin(
  dir: string,
  fallbackName: string,
): Promise<Omit<CursorPlugin, 'enabledHere'> | null> {
  for (const path of CURSOR_PLUGIN_MANIFEST_PATHS) {
    const manifest = parsePluginManifest(
      await readPluginFile(dir, join(...path)),
    );
    if (manifest === null) {
      continue;
    }
    // The CLI's order: the plugin's own default files first (the first to name
    // a server keeps it), then the manifest's servers over them by name.
    const servers: Record<string, unknown> = {};
    for (const file of CURSOR_PLUGIN_DEFAULT_MCP_FILES) {
      const found = parseMcpServers(await readPluginFile(dir, file));
      for (const [name, config] of Object.entries(found ?? {})) {
        if (!Object.hasOwn(servers, name)) {
          servers[name] = config;
        }
      }
    }
    if (manifest.servers?.kind === 'inline') {
      Object.assign(servers, manifest.servers.servers);
    } else if (manifest.servers?.kind === 'pointer') {
      Object.assign(
        servers,
        parseMcpServers(await readPluginFile(dir, manifest.servers.path)) ?? {},
      );
    }
    const listed = pluginServersOf(servers);
    return {
      name: manifest.name ?? fallbackName,
      dir,
      servers: listed,
      variables: [
        ...manifest.variables,
        ...inferredVariables(listed, manifest.variables),
      ],
    };
  }
  return null;
}

/**
 * Every installed plugin that declares an MCP server, with whether the folder
 * enables it. A marketplace install outranks a local copy of the same name, as
 * it does in the CLI.
 *
 * The enablement is read from the folder itself first — where the CLI reads it
 * — and then from its project root, where Cursor's app records a project
 * install when opened on the repository.
 */
export async function readCursorPlugins(
  cursorHome: string,
  cwd: string,
): Promise<CursorPlugin[]> {
  const settingsOf = (dir: string) =>
    readFileSafe(join(dir, CURSOR_HOME_DIR_NAME, CURSOR_SETTINGS_FILE_NAME));
  const projectRoot = cursorProjectRoot(cwd);
  const states = parseProjectPluginStates(
    (await settingsOf(cwd)) ??
      (projectRoot === cwd ? null : await settingsOf(projectRoot)),
  );
  const roots = await pluginRoots(cursorHome);
  const read = await Promise.all(
    roots.map((root) => readPlugin(root.dir, root.fallbackName)),
  );
  const plugins: CursorPlugin[] = [];
  const seen = new Set<string>();
  for (const plugin of read) {
    if (
      plugin === null ||
      plugin.servers.length === 0 ||
      seen.has(plugin.name)
    ) {
      continue;
    }
    seen.add(plugin.name);
    plugins.push({ ...plugin, enabledHere: states.get(plugin.name) ?? null });
  }
  return plugins;
}

/**
 * The listing's view of the plugins, each server marked with the config entry
 * already carrying it — the same name, or a URL its template could have
 * produced on a host the template names. `entries` is the CLI's merged `mcpServers`, the workspace's over
 * the user's.
 */
export function describeCursorPlugins(
  plugins: readonly CursorPlugin[],
  entries: Readonly<Record<string, unknown>>,
): AgentMcpPlugin[] {
  const copiedAs = (
    plugin: CursorPlugin,
    server: CursorPluginServer,
  ): string | null => {
    const template = payloadString(server.config, 'url');
    if (template !== null) {
      for (const [name, entry] of Object.entries(entries)) {
        const url = payloadString(entry, 'url');
        if (
          url !== null &&
          templateMatches(template, url) &&
          templateHostMatches(template, url, plugin.variables)
        ) {
          return name;
        }
      }
    }
    return Object.hasOwn(entries, server.name) ? server.name : null;
  };
  return plugins.map((plugin) => ({
    name: plugin.name,
    enabledHere: plugin.enabledHere,
    variables: plugin.variables,
    servers: plugin.servers.map((server) => ({
      name: server.name,
      id: pluginServerId(plugin.name, server.name),
      ...pluginServerTarget(server.config),
      copiedAs: copiedAs(plugin, server),
    })),
  }));
}
