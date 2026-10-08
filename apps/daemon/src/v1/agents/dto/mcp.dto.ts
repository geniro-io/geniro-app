import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { cliPositionalArgSchema } from '../../../utils/cli-positional-arg';
import { AgentKindSchema } from '../../runs/runs.types';
import {
  MAX_MCP_SERVER_NAME_LENGTH,
  MCP_CONTROL_CHARACTER,
} from '../adapters/utils/mcp-config.utils';
import {
  AgentMcpConfigWireSchema,
  AgentMcpListingWireSchema,
  AgentMcpServerDefinitionsWireSchema,
} from '../chat.types';

/**
 * Query for the MCP-server listing — which agent, and the folder whose servers
 * it would load (validated server-side by `resolveValidCwd`). `refresh` skips
 * the cached health reading; it is what the panel's Refresh control sets, and
 * the only way a server that has since recovered is re-dialled.
 *
 * `cwd` is OPTIONAL because the graph builder genuinely has no folder — a
 * workflow is edited long before it runs in one. Omitting it asks for the set
 * that does not depend on a folder (the user's global servers, plus whatever
 * `configDir` brings); the project-scope servers of whichever folder the run
 * lands in are added by the CLI itself at run time.
 *
 * `configDir` is a node's own agent config directory (validated server-side by
 * `resolveValidConfigDir`). A profile carries its own MCP servers, which is what
 * makes two agent nodes' listings genuinely differ.
 */
export const listMcpServersQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1).optional(),
  configDir: z.string().min(1).optional(),
  refresh: z.stringbool().optional(),
});
export class ListMcpServersQueryDto extends createZodDto(
  listMcpServersQuerySchema,
) {}

/**
 * Body for switching one server on or off, for one agent in one folder.
 *
 * The server is named rather than indexed: the listing is re-read between the
 * render and the click, and a position would silently retarget if the set
 * changed underneath.
 *
 * `server` is the shared {@link cliPositionalArgSchema}: this value reaches
 * `cursor-agent mcp enable|disable <server>` / `mcp list-tools <server>` as a
 * trailing positional, the identical argv shape `cli-auth.dto.ts`'s
 * `mcpLoginQuerySchema.server` guards against a leading-dash flag injection —
 * one schema so the two routes cannot drift apart on the same guard again.
 *
 * `configDir` names the same profile {@link listMcpServersQuerySchema} does,
 * and it is here because the WRITE has to land in the file the READ was taken
 * from. Without it this route read a profile's servers and then edited the
 * CLI's default config: under a custom config directory the switch moved on
 * screen, changed nothing for that profile, and silently rewrote the default
 * profile's disabled list instead — the silent no-op
 * {@link AgentMcpService.setEnabled} exists to refuse.
 */
export const setMcpServerEnabledSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  configDir: z.string().min(1).optional(),
  server: cliPositionalArgSchema,
  /** True to load the server on the next turn, false to leave it out. */
  enabled: z.boolean(),
});
export class SetMcpServerEnabledDto extends createZodDto(
  setMcpServerEnabledSchema,
) {}

/**
 * Body for re-dialling ONE server and answering with the listing that results.
 *
 * Deliberately not a flag on {@link listMcpServersQuerySchema}: `refresh` there
 * re-dials EVERY server the folder loads (~30s on a 47-server profile), and
 * this exists precisely because that is the wrong price for re-checking one row
 * after a browser sign-in. Same shape as the toggle body minus `enabled` —
 * `server` takes the shared {@link cliPositionalArgSchema} for the same reason
 * it does there.
 *
 * A POST rather than a GET because it DIALS: asking costs a spawned process
 * that starts the user's own server, which is not what a GET promises.
 */
export const recheckMcpServerSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  configDir: z.string().min(1).optional(),
  server: cliPositionalArgSchema,
});
export class RecheckMcpServerDto extends createZodDto(recheckMcpServerSchema) {}

/**
 * Body for copying one plugin's MCP server into the CLI's own user-scope
 * config. `server` becomes an `mcp.json` key and later the positional of `mcp
 * login <name>`, so it takes the shared {@link cliPositionalArgSchema};
 * `variables` are values for the plugin's declared, non-secret variables,
 * checked again against the manifest by the adapter.
 */
export const copyPluginMcpServerSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  configDir: z.string().min(1).optional(),
  plugin: z.string().min(1).max(200),
  server: cliPositionalArgSchema,
  variables: z
    .record(z.string().min(1).max(200), z.string().max(2000))
    .refine((values) => Object.keys(values).length <= 32, {
      message: 'at most 32 variables',
    }),
});
export class CopyPluginMcpServerDto extends createZodDto(
  copyPluginMcpServerSchema,
) {}

/**
 * Query for one profile's editable MCP document. No `cwd`: the document is
 * the profile's USER-scope servers, which no folder changes.
 */
export const readMcpConfigQuerySchema = z.object({
  agent: AgentKindSchema,
  configDir: z.string().min(1).optional(),
});
export class ReadMcpConfigQueryDto extends createZodDto(
  readMcpConfigQuerySchema,
) {}

/**
 * Body for saving the JSON editor: the profile's whole server map as it should
 * read afterwards, and the `version` the editor opened. The map's VALUES are
 * the CLI's own format and are checked server-side for the shape every CLI
 * shares (`checkMcpServerDefinitions`) rather than here, so one sentence
 * explains a refusal whichever field was wrong.
 */
export const writeMcpConfigSchema = z.object({
  agent: AgentKindSchema,
  configDir: z.string().min(1).optional(),
  servers: AgentMcpServerDefinitionsWireSchema,
  version: z.string().max(200).nullable(),
});
export class WriteMcpConfigDto extends createZodDto(writeMcpConfigSchema) {}

/** No control characters — every one of these reaches argv or a header. */
const mcpPlainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => !MCP_CONTROL_CHARACTER.test(value),
      'must not contain control characters',
    );

/** An env name the way a shell spells one — it rides `KEY=VALUE` argv. */
const MCP_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * An HTTP header name (RFC 9110 token), starting with a letter or digit: it
 * rides `-H "Name: value"` argv, where a leading dash would read as a flag.
 */
const MCP_HEADER_NAME = /^[A-Za-z0-9][!#$%&'*+.^_`|~0-9A-Za-z-]*$/;

/**
 * Body for the "Add" form: one server, added through the CLI's own mechanism
 * (`AgentAdapter.addMcpServer`). `name` is `cliPositionalArgSchema` because it
 * becomes `mcp add <name>`'s positional — the guard every such route shares.
 * A `stdio` server names a command, an `http` one an http(s) URL; the other
 * transport's fields must be empty rather than silently dropped.
 */
export const addMcpServerSchema = z
  .object({
    agent: AgentKindSchema,
    configDir: z.string().min(1).optional(),
    name: cliPositionalArgSchema.refine(
      (name) =>
        name.length <= MAX_MCP_SERVER_NAME_LENGTH &&
        !MCP_CONTROL_CHARACTER.test(name) &&
        !/\s/.test(name),
      `at most ${MAX_MCP_SERVER_NAME_LENGTH} characters, with no spaces or control characters`,
    ),
    transport: z.enum(['stdio', 'http']),
    command: mcpPlainText(4096).optional(),
    args: z.array(mcpPlainText(4096)).max(64).default([]),
    env: z
      .record(z.string().regex(MCP_ENV_KEY), mcpPlainText(8192))
      .refine((values) => Object.keys(values).length <= 64, {
        message: 'at most 64 environment variables',
      })
      .default({}),
    url: mcpPlainText(4096).optional(),
    headers: z
      .record(z.string().regex(MCP_HEADER_NAME).max(256), mcpPlainText(8192))
      .refine((values) => Object.keys(values).length <= 64, {
        message: 'at most 64 headers',
      })
      .default({}),
  })
  .superRefine((body, ctx) => {
    if (body.transport === 'stdio') {
      if (!body.command?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'a stdio server needs a command',
        });
      }
      if (body.url !== undefined || Object.keys(body.headers).length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'a stdio server takes no URL or headers',
        });
      }
      return;
    }
    if (!body.url || !/^https?:\/\/\S+$/i.test(body.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'an http server needs an http:// or https:// URL',
      });
    }
    if (
      body.command !== undefined ||
      body.args.length > 0 ||
      Object.keys(body.env).length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'an http server takes no command, arguments or environment',
      });
    }
  });
export class AddMcpServerDto extends createZodDto(addMcpServerSchema) {}

/** A profile's editable MCP document, or why it cannot be edited. */
export class AgentMcpConfigDto extends createZodDto(AgentMcpConfigWireSchema) {}

/** One agent's MCP servers in a working directory, or why it cannot be asked. */
export class AgentMcpListingDto extends createZodDto(
  AgentMcpListingWireSchema,
) {}
