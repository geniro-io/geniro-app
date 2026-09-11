import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Schema } from '@cfworker/json-schema';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';

import { tempDir } from '../../__tests__/temp-dir';
import type { AgentEvent, AgentTurnInput } from '../adapter.types';
import { ACP_AGENT_METHODS } from './acp.types';
import type { AcpTurnOptions } from './acp-driver';
import { acpModelProbeFrames } from './acp-models';
import { AcpSession } from './acp-session';
import { acpSessionListFrames, acpSessionLoadFrames } from './acp-sessions';

/**
 * The release this pin is taken from, and how to move it.
 *
 * Take the RELEASE ASSET. `main` matches it today and is not a pin, and npm is
 * worse than not a pin: `@agentclientprotocol/sdk@1.4.0` exports as
 * `./schema/schema.json` a file byte-identical to this release's
 * `schema.unstable.json` (265 `$defs`, `Nes*`/`Compaction*`/`ForkSession*`), so
 * the npm route pins the UNSTABLE document under a stable-looking name.
 *
 * To refresh: download the asset, save it under the NEW version's filename,
 * delete the old one, point `SCHEMA_FILE` at it, put the new tag, url, hash and
 * counts here — then read the failures. A send shape that stops validating is
 * the drift this file exists to catch.
 */
const PIN = {
  tag: 'schema-v1.21.0',
  url: 'https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.21.0/schema.json',
  sha256: 'caf62ff962ada396878372ced11efb2c6764e59d90919a38583c319948931a42',
  bytes: 246569,
  defs: 170,
  draft: 'https://json-schema.org/draft/2020-12/schema',
} as const;

/**
 * Named here rather than read from `package.json`: this is the string the guard
 * below scans production sources for, and a spec is excluded from that scan.
 */
const VALIDATOR_PACKAGE = '@cfworker/json-schema';

/** Version-stamped, so refreshing the pin is an add-and-delete in the diff. */
const SCHEMA_FILE = 'acp-schema.v1.21.0.json';

/**
 * Read rather than imported. `import` under `resolveJsonModule` makes `tsc`
 * infer the literal type of the whole document; and the hash has to be taken
 * over the real bytes, which a module object no longer is.
 */
const SCHEMA_BYTES = readFileSync(join(__dirname, '__tests__', SCHEMA_FILE));
const SCHEMA = JSON.parse(SCHEMA_BYTES.toString('utf8')) as {
  $schema: string;
  $defs: Record<string, Schema>;
};

/**
 * Which `$defs` entry each method this client calls is judged against.
 *
 * `satisfies Record<keyof typeof ACP_AGENT_METHODS, …>` is the point: a method
 * added to that constant does not compile until somebody says which shape it
 * sends. That guard is per METHOD, and several of these are composed at more
 * than one call site, so the cases below reach four compositions by hand: the
 * three exported handshake builders and a live turn.
 *
 * FOUR compositions are not reached, and are named here so that "is my call
 * site covered?" has an answer. Three build a params object structurally
 * identical to one already covered, so a case would assert the same
 * requirements against the same def — coverage by count rather than by risk:
 * `sendFollowUp`'s `session/prompt`, `applyModelParameters`'
 * `session/set_config_option`, and the load-failure fallback's `session/new`.
 * The fourth, `session/set_model`, is unreached for the opposite reason: the
 * schema declares nothing to validate it against, which is itself the
 * divergence the last block below pins.
 */
const SEND_SHAPES = {
  initialize: 'InitializeRequest',
  sessionNew: 'NewSessionRequest',
  sessionLoad: 'LoadSessionRequest',
  sessionList: 'ListSessionsRequest',
  sessionPrompt: 'PromptRequest',
  sessionSetMode: 'SetSessionModeRequest',
  sessionSetConfigOption: 'SetSessionConfigOptionRequest',
  sessionCancel: 'CancelNotification',
  sessionSetModel: null,
} as const satisfies Record<keyof typeof ACP_AGENT_METHODS, string | null>;

/**
 * One validator per `$defs` entry.
 *
 * The whole document is the validator's root with a `$ref` bolted on, rather
 * than the bare subschema: every request def `$ref`s its way into the rest of
 * the document (a `PromptRequest`'s blocks are `ContentBlock`s), and a bare
 * subschema root leaves those pointers resolving against nothing.
 */
function validatorFor(defName: string): Validator {
  return new Validator(
    {
      $schema: SCHEMA.$schema,
      $defs: SCHEMA.$defs,
      $ref: `#/$defs/${defName}`,
    },
    '2020-12',
  );
}

/** The schema's own complaints, as lines a failure message can be read from. */
function conformanceErrors(defName: string, params: unknown): string[] {
  if (params === undefined) {
    // A frame the client never sent arrives here as `undefined`, and the
    // validator answers that by THROWING `Instances of "undefined" type are not
    // supported` — which reads as a fault in the validator rather than as the
    // real one. Naming it keeps a vanished frame from being diagnosed as a
    // library problem.
    return [`no frame: this client sent no ${defName} params at all`];
  }
  const result = validatorFor(defName).validate(params);
  return result.valid
    ? []
    : result.errors.map(
        (error) =>
          `${error.instanceLocation}: ${error.error} (${error.keyword})`,
      );
}

/**
 * The params of one encoded frame.
 *
 * `string | undefined` rather than `string` because the project compiles with
 * `noUncheckedIndexedAccess`, so destructuring a builder's array says a frame
 * may be absent — and passing that absence through undecorated is what lets it
 * arrive at {@link conformanceErrors} as the named "no frame" failure instead
 * of a cast that would hide it.
 */
function paramsOfFrame(frame: string | undefined): unknown {
  return frame === undefined
    ? undefined
    : (JSON.parse(frame) as { params: unknown }).params;
}

/**
 * A session driven far enough to have written its outgoing frames.
 *
 * The frames a turn sends are built inline at private call sites, so a session
 * that actually sent them is the only honest source for them.
 *
 * `acp-driver.spec.ts`'s `harness` is a superset of this, but is not exported.
 * If anything else needs a session double, extract rather than write a third.
 */
interface Driven {
  session: AcpSession;
  feed: (message: unknown) => void;
  paramsFor: (method: string) => unknown;
}

const BASE_INPUT: AgentTurnInput = { prompt: 'do the thing', cwd: '/work' };

/** Stands in for whatever vendor bag an adapter declares; see `drive`. */
const CLIENT_META = { parameterizedModelPicker: true };

function drive(overrides: Partial<AcpTurnOptions> = {}): Driven {
  const sent: Record<string, unknown>[] = [];
  const turn: AcpTurnOptions = {
    input: BASE_INPUT,
    autoDecide: () => null,
    // Empty rather than absent: the driver measures this before deciding
    // whether the prompt carries a host-context block at all.
    composeSystemPrompt: () => '',
    ...overrides,
  };

  const session = new AcpSession(
    {
      clientName: 'geniro',
      clientVersion: '1.2.3',
      // Every shipped ACP adapter declares one, so a session driven without it
      // validates the one variant no real chat sends. It buys no new failure
      // mode — `ClientCapabilities._meta` is a declared property the schema
      // deliberately leaves unconstrained — only that what is checked here is
      // what goes out.
      clientMeta: CLIENT_META,
      turnOptions: (turnInput) => ({ ...turn, input: turnInput }),
    },
    turn.input,
  );
  session.onStdinReady({
    write: (payload: string) => {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      return true;
    },
    emit: (_event: AgentEvent) => undefined,
  });

  return {
    session,
    feed: (message) => void session.onMessage(message),
    paramsFor: (method) =>
      sent.find((frame) => frame.method === method)?.params,
  };
}

/**
 * The reply to `initialize`, with the capabilities a case needs.
 *
 * Every one defaults to FALSE, and each false closes a branch of what the
 * client goes on to send: no `mcpHttp` means `session/new` and `session/load`
 * carry `mcpServers: []` whatever endpoint the turn holds, and no `image` means
 * a prompt is text-only however many attachments it has. A case that means to
 * validate one of those richer shapes has to turn the capability on.
 */
function initializeReply(
  capabilities: {
    loadSession?: boolean;
    mcpHttp?: boolean;
    image?: boolean;
  } = {},
): unknown {
  return {
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: capabilities.loadSession ?? false,
        mcpCapabilities: { http: capabilities.mcpHttp ?? false },
        promptCapabilities: { image: capabilities.image ?? false },
      },
    },
  };
}

/** A caller node's call surface, which is what puts a real entry in `mcpServers`. */
const MCP_ENDPOINT = {
  url: 'http://127.0.0.1:1/v1/mcp/run-1/node-1',
  token: 'tok-1',
  serverName: 'geniro-run1',
};

describe('the pinned ACP schema release', () => {
  it('is the release asset unmodified, byte for byte', () => {
    // A formatter or an editor rewriting this file is the failure mode: it
    // would still parse, still validate everything, and no longer be the
    // document the vendor published. `.prettierignore` keeps prettier off it;
    // this is what notices anything else.
    expect(createHash('sha256').update(SCHEMA_BYTES).digest('hex')).toBe(
      PIN.sha256,
    );
    expect(SCHEMA_BYTES.byteLength).toBe(PIN.bytes);
    // The refresh procedure says to move the tag AND the url; a follower who
    // moves only the tag downloads the previous release next time, from a
    // string nothing else reads.
    expect(PIN.url).toContain(PIN.tag);
  });

  it('is the STABLE document, not the unstable one published beside it', () => {
    // Documentation rather than independent coverage: any file state with a
    // different count also has a different hash, so the assertion above fails
    // first. What it carries is WHICH of the release's two assets this is —
    // they differ by ~95 definitions, and the unstable one is what npm serves.
    expect(Object.keys(SCHEMA.$defs)).toHaveLength(PIN.defs);
    expect(SCHEMA.$schema).toBe(PIN.draft);
  });
});

describe('the validator this file runs on', () => {
  it('is imported by no production file', () => {
    // `@cfworker/json-schema` is a devDependency, so `pnpm deploy --prod`
    // strips it from the packaged daemon. It ALSO satisfies an optional peer of
    // `@modelcontextprotocol/sdk`, which is a real dependency — so a production
    // import would resolve here, resolve in CI, and be missing on the user's
    // machine, with every suite green throughout. Nothing else would notice.
    const src = join(__dirname, '..', '..', '..', '..');
    const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .filter((name) =>
        readFileSync(join(src, name), 'utf8').includes(VALIDATOR_PACKAGE),
      );

    expect(offenders).toEqual([]);
  });
});

describe('the request shapes this client sends', () => {
  /**
   * What a failure here means, and what it does not. NO def in this release
   * declares `additionalProperties`, which JSON Schema reads as
   * "extra properties allowed" — so this catches a missing required field, a
   * field of the wrong type, and a nested shape that no longer fits, and it does
   * NOT catch a misspelled field name. Widening it is not this file's to do: the
   * schema says what it says.
   */
  it('covers every agent method the client can call', () => {
    expect(Object.keys(SEND_SHAPES).sort()).toEqual(
      Object.keys(ACP_AGENT_METHODS).sort(),
    );
  });

  it('names a real definition for every shape it claims to check', () => {
    const missing = Object.values(SEND_SHAPES).filter(
      (name) => name !== null && !(name in SCHEMA.$defs),
    );
    expect(missing).toEqual([]);
  });

  describe('frames built by an exported builder', () => {
    // Each of these builders composes its OWN `initialize`, so validating one
    // says nothing about the others — which is why all three are checked.
    it('conforms on the session listing handshake', () => {
      const [init, list] = acpSessionListFrames({
        cwd: '/work',
        clientName: 'geniro',
        clientVersion: '1.2.3',
        clientMeta: CLIENT_META,
      });

      expect(
        conformanceErrors(SEND_SHAPES.initialize, paramsOfFrame(init)),
      ).toEqual([]);
      // A weak pin by the schema's own doing: `ListSessionsRequest` declares no
      // required property, so only a wrong-TYPED `cwd` can fail it.
      expect(
        conformanceErrors(SEND_SHAPES.sessionList, paramsOfFrame(list)),
      ).toEqual([]);
    });

    it('conforms on the session load handshake', () => {
      const [init, load] = acpSessionLoadFrames({
        sessionId: 'sess-import',
        cwd: '/work',
        clientName: 'geniro',
        clientVersion: '1.2.3',
        clientMeta: CLIENT_META,
      });

      expect(
        conformanceErrors(SEND_SHAPES.initialize, paramsOfFrame(init)),
      ).toEqual([]);
      expect(
        conformanceErrors(SEND_SHAPES.sessionLoad, paramsOfFrame(load)),
      ).toEqual([]);
    });

    it('conforms on the model probe handshake', () => {
      const [init, newSession] = acpModelProbeFrames({
        cwd: '/work',
        clientName: 'geniro',
        clientVersion: '1.2.3',
        clientMeta: CLIENT_META,
      });

      expect(
        conformanceErrors(SEND_SHAPES.initialize, paramsOfFrame(init)),
      ).toEqual([]);
      expect(
        conformanceErrors(SEND_SHAPES.sessionNew, paramsOfFrame(newSession)),
      ).toEqual([]);
    });

    it('says so when a frame was never sent, rather than blaming the validator', () => {
      expect(conformanceErrors(SEND_SHAPES.sessionPrompt, undefined)).toEqual([
        'no frame: this client sent no PromptRequest params at all',
      ]);
    });
  });

  describe('frames a running turn builds inline', () => {
    /**
     * A turn that asks for a mode and a model, so the `set_mode` and
     * `set_config_option` frames both go out. NOT `set_model`: enumerating the
     * model under `configOptions` is what makes the driver take the replacement
     * and return before the legacy frame.
     */
    function turnSettingEverything(): Driven {
      const driven = drive({
        input: { ...BASE_INPUT, model: 'opus-5' },
        preferredModeId: 'plan',
      });
      driven.feed(initializeReply());
      driven.feed({
        id: 2,
        result: {
          sessionId: 'sess-1',
          modes: {
            currentModeId: 'normal',
            availableModes: [{ id: 'normal' }, { id: 'plan' }],
          },
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'sonnet-5',
              options: [
                { value: 'opus-5', name: 'opus-5' },
                { value: 'sonnet-5', name: 'sonnet-5' },
              ],
            },
          ],
        },
      });
      return driven;
    }

    // `initialize` again: a live turn composes its own, unlike the three
    // builders above, and this is the one every real chat opens with.
    it.each([
      [ACP_AGENT_METHODS.initialize, SEND_SHAPES.initialize],
      [ACP_AGENT_METHODS.sessionNew, SEND_SHAPES.sessionNew],
      [ACP_AGENT_METHODS.sessionPrompt, SEND_SHAPES.sessionPrompt],
      [ACP_AGENT_METHODS.sessionSetMode, SEND_SHAPES.sessionSetMode],
      [
        ACP_AGENT_METHODS.sessionSetConfigOption,
        SEND_SHAPES.sessionSetConfigOption,
      ],
    ])('conforms on %s', (method, defName) => {
      const params = turnSettingEverything().paramsFor(method);

      expect(params).toBeDefined();
      expect(conformanceErrors(defName, params)).toEqual([]);
    });

    it('conforms on session/new carrying a caller node’s MCP server', () => {
      // Needs the capability AND the endpoint: either missing and the list is
      // empty, which the cases above already validate.
      const driven = drive({
        input: { ...BASE_INPUT, mcpEndpoint: MCP_ENDPOINT },
      });
      driven.feed(initializeReply({ mcpHttp: true }));

      const params = driven.paramsFor(ACP_AGENT_METHODS.sessionNew);
      expect(params).toBeDefined();
      expect((params as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);
      expect(conformanceErrors(SEND_SHAPES.sessionNew, params)).toEqual([]);
    });

    it('conforms on session/load when a turn RESUMES a conversation', () => {
      // A different frame from the import builder's, which sends `mcpServers:
      // []` by construction — so this needs the endpoint AND the capability, or
      // it re-validates the shape already covered above and its name lies.
      const driven = drive({
        input: {
          ...BASE_INPUT,
          resumeSessionId: 'prior-7',
          mcpEndpoint: MCP_ENDPOINT,
        },
      });
      driven.feed(initializeReply({ loadSession: true, mcpHttp: true }));

      const params = driven.paramsFor(ACP_AGENT_METHODS.sessionLoad);
      expect(params).toBeDefined();
      expect((params as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);
      expect(conformanceErrors(SEND_SHAPES.sessionLoad, params)).toEqual([]);
    });

    it('conforms on session/prompt carrying an image block', () => {
      // Attachments are a live send path with an expensive failure: an image
      // block the agent cannot read earns an error reply that costs the whole
      // message. It is also gated on `promptCapabilities.image`, so every other
      // case in this file sends text only.
      const file = join(tempDir('acp-conformance-'), 'shot.png');
      writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const driven = drive({
        input: {
          ...BASE_INPUT,
          images: [{ path: file, mediaType: 'image/png' }],
        },
      });
      driven.feed(initializeReply({ image: true }));
      driven.feed({ id: 2, result: { sessionId: 'sess-1' } });

      const params = driven.paramsFor(ACP_AGENT_METHODS.sessionPrompt);
      expect(params).toBeDefined();
      const blocks = (params as { prompt: { type: string }[] }).prompt;
      expect(blocks.map((block) => block.type)).toContain('image');
      expect(conformanceErrors(SEND_SHAPES.sessionPrompt, params)).toEqual([]);
    });

    it('conforms on the session/cancel notification', () => {
      const frame = turnSettingEverything().session.buildInterruptPayload();

      expect(frame).toBeDefined();
      expect(
        conformanceErrors(SEND_SHAPES.sessionCancel, paramsOfFrame(frame)),
      ).toEqual([]);
    });
  });
});

describe('where the installed binary diverges from the pinned schema', () => {
  /**
   * Each of these is a measurement recorded on a symbol in `acp.types.ts`,
   * restated here as an assertion about the SCHEMA. A red test in this block
   * does not mean the client is wrong — it means a divergence has closed or
   * moved, which is the moment to re-read the note it came from rather than to
   * change the client.
   */

  it('declares nothing at all for session/set_model', () => {
    // Recorded on `AcpSetModelParams`. What this can observe is the PINNED
    // release and no other — the wider claim about every stable release is a
    // dated reading of the vendor's assets, recorded there. cursor-agent
    // 2026.08.04-aaa8809 still answers the method with `{}`.
    //
    // Asserted on the schema's own per-method annotation rather than on def
    // NAMES: a name filter fires on any future `ModelInfo` the client never
    // sends, which is the ossification this file is supposed to avoid.
    expect(SEND_SHAPES.sessionSetModel).toBeNull();
    // The annotation has to be anchored before it can be filtered on. A release
    // that renamed or dropped `x-method` would otherwise make the filter below
    // yield `[]` and report "no set_model" having observed nothing — a pin
    // certifying a divergence it can no longer see, at the pin refresh, which
    // is the one moment this file exists for.
    expect(
      (SCHEMA.$defs.PromptRequest as { 'x-method'?: string })['x-method'],
    ).toBe('session/prompt');
    expect(
      Object.entries(SCHEMA.$defs)
        .filter(
          ([, def]) =>
            (def as { 'x-method'?: string })['x-method'] ===
            'session/set_model',
        )
        .map(([name]) => name),
    ).toEqual([]);
  });

  it('spells the config option key `configId`, as the binary does', () => {
    // Recorded on `AcpSetConfigOptionParams`. The schema sides with the binary
    // against the docs' prose, so the divergence is the DOCUMENTATION's.
    const required = (
      SCHEMA.$defs.SetSessionConfigOptionRequest as { required: string[] }
    ).required;
    expect(required).toContain('configId');
    expect(required).not.toContain('configOptionId');
  });

  // Three further divergences are recorded in `acp.types.ts` and are not
  // assertable here, because this schema has nothing to say about any of them:
  // on `AcpModel`, the legacy block keys on `modelId` rather than the `id` its
  // sibling `modes.availableModes` uses, and the handshake's model ids are the
  // agent's own namespace; on `AcpToolCall.locations`, an empty set is omitted
  // entirely rather than sent as `[]`. All three are behaviours of a binary,
  // provable only by probing one — and the last is read-side, which this file
  // deliberately does not cover.
});
