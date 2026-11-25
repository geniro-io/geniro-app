import { z } from 'zod';

import { hasHiddenText } from '../agents/utils/hidden-text';

export const PLUGINS_DIR_NAME = 'plugins';
export const PLUGIN_SUFFIX = '.plugin.yaml';
export const PLUGIN_BACKUP_DIR = '.backups';
export const PLUGIN_APPROVED_DIR = '.approved';
export const PLUGIN_BACKUPS_KEPT = 20;

/** Lowercase only: two slugs differing in case would name one file on macOS. */
export const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PLUGIN_BUTTON_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Only these names: `buildChildEnv` merges extra keys last, so PATH or DYLD_* from data would pick what runs. */
export const PLUGIN_ENV_NAME_RE = /^PLUGIN_[A-Z0-9_]{1,57}$/;

export const PLUGIN_NAME_MAX = 80;
export const PLUGIN_COMMAND_MAX = 4000;
export const PLUGIN_FOLDERS_MAX = 50;
export const PLUGIN_BUTTONS_MAX = 10;
export const PLUGIN_REFRESH_MINUTES_DEFAULT = 5;
export const PLUGIN_REFRESH_MINUTES_MAX = 1440;
export const PLUGIN_TIMEOUT_SECONDS_DEFAULT = 30;
export const PLUGIN_TIMEOUT_SECONDS_MAX = 120;
export const PLUGIN_BUTTON_TIMEOUT_MINUTES_DEFAULT = 10;
export const PLUGIN_BUTTON_TIMEOUT_MINUTES_MAX = 60;
export const PLUGIN_OUTPUT_MAX_CHARS = 1024 * 1024;
export const PLUGIN_ENV_VALUE_MAX = 1024;
export const PLUGIN_MIN_REFRESH_MS = 60_000;
export const PLUGIN_ERROR_TEXT_MAX = 4096;
export const PLUGIN_NOT_JSON_HEAD = 2048;
export const PLUGIN_BUTTON_OUTPUT_TAIL_MAX = 4096;

/** View components a plugin may not use: nothing a user types into, and no overlay. */
export const PLUGIN_REFUSED_COMPONENTS = [
  'TextField',
  'CheckBox',
  'ChoicePicker',
  'Slider',
  'DateTimeInput',
  'Modal',
] as const;

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => !hasHiddenText(value, false),
      'must be one line, without control, invisible or bidirectional characters',
    );

export const PluginButtonFileSchema = z
  .object({
    id: z.string().regex(PLUGIN_BUTTON_ID_RE, 'letters, digits, - and _ only'),
    command: oneLine(PLUGIN_COMMAND_MAX),
    confirm: z.boolean().default(false),
    timeout_minutes: z
      .number()
      .int()
      .min(1)
      .max(PLUGIN_BUTTON_TIMEOUT_MINUTES_MAX)
      .default(PLUGIN_BUTTON_TIMEOUT_MINUTES_DEFAULT),
    env: z
      .record(
        z.string().regex(PLUGIN_ENV_NAME_RE, 'must match PLUGIN_[A-Z0-9_]'),
        z
          .string()
          .max(500)
          .refine(
            (pointer) => pointer === '' || pointer.startsWith('/'),
            'must be a JSON pointer into the data, starting with "/"',
          ),
      )
      .optional(),
  })
  .strict();

/** One plugin file, `<userData>/plugins/<slug>.plugin.yaml`, with its defaults applied. */
export const PluginFileSchema = z
  .object({
    name: oneLine(PLUGIN_NAME_MAX),
    enabled: z.boolean().default(true),
    folders: z
      .array(z.string().min(1).max(4096))
      .max(PLUGIN_FOLDERS_MAX)
      .default([]),
    refresh_minutes: z
      .number()
      .int()
      .min(1)
      .max(PLUGIN_REFRESH_MINUTES_MAX)
      .default(PLUGIN_REFRESH_MINUTES_DEFAULT),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(PLUGIN_TIMEOUT_SECONDS_MAX)
      .default(PLUGIN_TIMEOUT_SECONDS_DEFAULT),
    command: oneLine(PLUGIN_COMMAND_MAX),
    view: z.array(z.record(z.string(), z.unknown())).min(1),
    buttons: z
      .array(PluginButtonFileSchema)
      .max(PLUGIN_BUTTONS_MAX)
      .default([]),
  })
  .strict();

export type PluginFile = z.infer<typeof PluginFileSchema>;
export type PluginButtonFile = z.infer<typeof PluginButtonFileSchema>;

/** A plugin as read: its file's fields with the folders expanded and canonicalized. */
export interface Plugin extends PluginFile {
  /** Each folder as written, `~` expanded and symlinks resolved when it exists. */
  resolvedFolders: string[];
}

export const PLUGIN_STATES = ['approved', 'changed', 'invalid'] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];

/** One plugin file as the store reads it. */
export interface StoredPlugin {
  slug: string;
  text: string;
  hash: string;
  approvedText: string | null;
  state: PluginState;
  plugin: Plugin | null;
  error: string | null;
}

export const PluginRunResultSchema = z
  .object({
    at: z.string().describe('When the command finished (ISO 8601)'),
    data: z
      .unknown()
      .describe("The command's stdout parsed as JSON, or null when it failed"),
    error: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    stderrTail: z.string(),
  })
  .meta({ id: 'PluginRunResult' });
export type PluginRunResult = z.infer<typeof PluginRunResultSchema>;

export const PluginButtonWireSchema = z
  .object({
    id: z.string(),
    command: z.string(),
    confirm: z.boolean(),
  })
  .meta({ id: 'PluginButton' });

export const PluginSummarySchema = z
  .object({
    slug: z.string(),
    name: z.string().nullable().describe('Null when the file does not read'),
    enabled: z.boolean(),
    folders: z.array(z.string()),
    refreshMinutes: z.number().int(),
    command: z.string().nullable(),
    buttons: z.array(PluginButtonWireSchema),
    state: z.enum(PLUGIN_STATES),
    error: z.string().nullable(),
    hash: z.string(),
    path: z.string().describe("The file's absolute path"),
    lastRunAt: z.string().nullable(),
  })
  .meta({ id: 'PluginSummary' });
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const PluginListSchema = z.object({
  plugins: z.array(PluginSummarySchema),
});
export type PluginList = z.infer<typeof PluginListSchema>;

export const PluginBlockSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    state: z.enum(PLUGIN_STATES),
    folder: z.string().describe('The folder the command runs in for this run'),
    view: z.array(z.record(z.string(), z.unknown())),
    refreshMinutes: z.number().int(),
    buttons: z.array(PluginButtonWireSchema),
    result: PluginRunResultSchema.nullable(),
  })
  .meta({ id: 'PluginBlock' });
export type PluginBlock = z.infer<typeof PluginBlockSchema>;

export const PluginBlockListSchema = z.object({
  blocks: z.array(PluginBlockSchema),
});
export type PluginBlockList = z.infer<typeof PluginBlockListSchema>;

export const PluginDetailSchema = z.object({
  slug: z.string(),
  text: z.string(),
  approvedText: z.string().nullable(),
  hash: z.string(),
  state: z.enum(PLUGIN_STATES),
  error: z.string().nullable(),
  path: z.string(),
});
export type PluginDetail = z.infer<typeof PluginDetailSchema>;

export const PluginRunRequestSchema = z.object({
  runId: z.string().min(1),
  force: z.boolean().optional(),
});

export const PluginFolderRunRequestSchema = z.object({
  folder: z
    .string()
    .min(1)
    .describe('The absolute folder to run the command in'),
  force: z.boolean().optional(),
});

export const PluginPressRequestSchema = z.object({
  runId: z.string().min(1),
  dataAt: z
    .string()
    .min(1)
    .describe('The `at` of the result the user saw when pressing'),
});

export const PluginPressResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  outputTail: z.string(),
  error: z.string().nullable(),
});
export type PluginPressResult = z.infer<typeof PluginPressResultSchema>;

export const PluginApproveRequestSchema = z.object({
  hash: z.string().min(1),
});

export const PluginPatchRequestSchema = z.object({
  enabled: z.boolean().optional(),
  folders: z
    .array(z.string().min(1).max(4096))
    .max(PLUGIN_FOLDERS_MAX)
    .optional(),
  baseHash: z.string().min(1),
});

export const PluginRemovedSchema = z.object({ removed: z.boolean() });

/** `plugins_changed`: a plugin file geniro wrote; null slug for several at once. */
export interface PluginsChangedEvent {
  slug: string | null;
}

/** What `save_plugin` is called with, read by its tool. */
export interface SavePluginInput {
  slug?: string;
  name: string;
  folders?: string[];
  refresh_minutes?: number;
  timeout_seconds?: number;
  command: string;
  view: Record<string, unknown>[];
  buttons?: {
    id: string;
    command: string;
    confirm?: boolean;
    timeout_minutes?: number;
    env?: Record<string, string>;
  }[];
  sample?: unknown;
}

export const PLUGIN_SAMPLE_MAX_CHARS = 256 * 1024;
