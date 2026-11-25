import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { Document, isMap, parseDocument } from 'yaml';
import type { z } from 'zod';

import { MAX_UI_COMPONENTS } from '../../agents/chat.types';
import { readA2uiMessages } from '../../agents/utils/a2ui/a2ui-validate';
import {
  type Plugin,
  PLUGIN_REFUSED_COMPONENTS,
  type PluginFile,
  PluginFileSchema,
} from '../plugins.types';

export type PluginFileInput = z.input<typeof PluginFileSchema>;

export type PluginRead =
  { ok: true; plugin: Plugin } | { ok: false; error: string };

const VIEW_SURFACE_ID = 'plugin';
const KEY_ORDER = [
  'name',
  'enabled',
  'folders',
  'refresh_minutes',
  'timeout_seconds',
  'command',
  'view',
  'buttons',
] as const satisfies readonly (keyof PluginFile)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `~` expanded, then symlinks resolved when the folder exists; null for a relative path. */
export function resolvePluginFolder(folder: string): string | null {
  const expanded =
    folder === '~'
      ? homedir()
      : folder.startsWith('~/')
        ? join(homedir(), folder.slice(2))
        : folder;
  if (!isAbsolute(expanded)) {
    return null;
  }
  const absolute = resolve(expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The view checked as `show_ui` checks a surface, plus what a plugin may not
 * do: no input component, no overlay, and every button event names a
 * declared button. Answers the first refusal as `<pointer>: <reason>`.
 */
export function pluginViewError(
  view: readonly Record<string, unknown>[],
  buttonIds: ReadonlySet<string>,
): string | null {
  if (view.length > MAX_UI_COMPONENTS) {
    return `/view: at most ${MAX_UI_COMPONENTS} components`;
  }
  const reading = readA2uiMessages([
    {
      version: '1.0',
      createSurface: {
        surfaceId: VIEW_SURFACE_ID,
        components: view,
        dataModel: { data: null },
      },
    },
  ]);
  if (!reading.ok) {
    return reading.error.replace(
      /^\/messages\/0\/createSurface\/components/,
      '/view',
    );
  }
  if (!view.some((component) => component.id === 'root')) {
    return '/view: one component must have the id "root"';
  }
  for (const [index, component] of view.entries()) {
    const kind = component.component;
    if (
      typeof kind === 'string' &&
      (PLUGIN_REFUSED_COMPONENTS as readonly string[]).includes(kind)
    ) {
      return `/view/${index}/component: a plugin view shows data only; ${kind} is not allowed`;
    }
    const action = component.action;
    if (kind === 'Button' && isRecord(action) && isRecord(action.event)) {
      const name = action.event.name;
      if (typeof name !== 'string' || !buttonIds.has(name)) {
        return `/view/${index}/action/event/name: names no button in \`buttons\` (${[...buttonIds].join(', ') || 'none declared'})`;
      }
    }
  }
  return null;
}

/** A plugin's fields checked whole, with its folders resolved. */
export function readPluginValue(value: unknown): PluginRead {
  const parsed = PluginFileSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pointer =
      issue === undefined || issue.path.length === 0
        ? '/'
        : `/${issue.path.map(String).join('/')}`;
    return { ok: false, error: `${pointer}: ${issue?.message ?? 'invalid'}` };
  }
  const file = parsed.data;
  const ids = new Set<string>();
  for (const [index, button] of file.buttons.entries()) {
    if (ids.has(button.id)) {
      return {
        ok: false,
        error: `/buttons/${index}/id: "${button.id}" is used by another button`,
      };
    }
    ids.add(button.id);
  }
  const viewError = pluginViewError(file.view, ids);
  if (viewError !== null) {
    return { ok: false, error: viewError };
  }
  const resolvedFolders: string[] = [];
  for (const [index, folder] of file.folders.entries()) {
    const resolved = resolvePluginFolder(folder);
    if (resolved === null) {
      return {
        ok: false,
        error: `/folders/${index}: must be an absolute path or start with ~/`,
      };
    }
    resolvedFolders.push(resolved);
  }
  return { ok: true, plugin: { ...file, resolvedFolders } };
}

/** One plugin file's text read and checked; never throws. */
export function readPluginText(text: string): PluginRead {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      error: `/: YAML parse error: ${doc.errors[0]!.message}`,
    };
  }
  return readPluginValue(doc.toJS());
}

/**
 * The file's text for `input`, merged into `existing` when it is a YAML map
 * so the user's comments on untouched keys survive. Keys `input` leaves out
 * are removed.
 */
export function pluginFileText(
  input: PluginFileInput,
  existing?: string | null,
): string {
  const plain = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (plain[key] !== undefined) {
      ordered[key] = plain[key];
    }
  }
  if (existing) {
    const doc = parseDocument(existing);
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      const current = doc.toJS() as Record<string, unknown>;
      for (const key of Object.keys(current)) {
        if (ordered[key] === undefined) {
          doc.delete(key);
        }
      }
      for (const key of KEY_ORDER) {
        if (
          ordered[key] !== undefined &&
          JSON.stringify(current[key]) !== JSON.stringify(ordered[key])
        ) {
          doc.set(key, ordered[key]);
        }
      }
      return doc.toString();
    }
  }
  return new Document(ordered).toString();
}

/** The top-level keys a plugin file's text holds as written, or {} when it is no YAML map. */
export function pluginFileFields(text: string): Record<string, unknown> {
  const doc = parseDocument(text);
  const value: unknown = doc.errors.length === 0 ? doc.toJS() : null;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `text` with only `enabled` and `folders` changed, comments kept. */
export function withPluginSettings(
  text: string,
  change: { enabled?: boolean; folders?: string[] },
): string {
  const doc = parseDocument(text);
  if (change.enabled !== undefined) {
    doc.set('enabled', change.enabled);
  }
  if (change.folders !== undefined) {
    doc.set('folders', change.folders);
  }
  return doc.toString();
}
