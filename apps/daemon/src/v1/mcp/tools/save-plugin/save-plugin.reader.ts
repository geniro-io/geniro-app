import { z } from 'zod';

import type { SavePluginInput } from '../../../plugins/plugins.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

const ButtonArgSchema = z
  .object({
    id: z
      .string()
      .describe(
        'The name a view Button sends as action.event.name to press it',
      ),
    command: z
      .string()
      .describe(
        "One shell line, run with /bin/sh -c in the chat's folder; data reaches it only through env",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'true asks the user first; set it on every button that deploys, deletes, writes or costs money',
      ),
    timeout_minutes: z
      .number()
      .int()
      .optional()
      .describe('Default 10, at most 60'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'PLUGIN_* variable name → JSON pointer into the data (e.g. {"PLUGIN_ID": "/items/0/id"})',
      ),
  })
  .strict();

export const SavePluginArgsSchema = z
  .object({
    slug: z
      .string()
      .optional()
      .describe(
        "An existing plugin's slug to change it; leave it out for a new plugin",
      ),
    name: z.string().describe('What the block is called, one line'),
    command: z
      .string()
      .describe(
        "One shell line run with /bin/sh -c in the chat's folder that prints JSON to stdout",
      ),
    view: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'A2UI v1.0 basic-catalog components, one with id "root"; bind to the output with {"@path": "/data/…"}',
      ),
    buttons: z.array(ButtonArgSchema).optional(),
    folders: z
      .array(z.string())
      .optional()
      .describe(
        "Absolute folders the block shows in (and inside them); leave it out for this chat's folder, [] for everywhere",
      ),
    refresh_minutes: z
      .number()
      .int()
      .optional()
      .describe('How often it refreshes while shown; default 5'),
    timeout_seconds: z
      .number()
      .int()
      .optional()
      .describe('How long the command may run; default 30, at most 120'),
    sample: z
      .unknown()
      .optional()
      .describe(
        'The JSON the command printed when you ran it yourself; the card previews the block from it',
      ),
  })
  .strict();

/** `save_plugin` arguments, or why they cannot be read. */
export function readSavePluginArgs(
  args: Record<string, unknown>,
): ToolArgs<SavePluginInput> {
  return readToolArgs(SavePluginArgsSchema, args);
}
