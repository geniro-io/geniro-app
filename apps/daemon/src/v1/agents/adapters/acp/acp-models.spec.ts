import { describe, expect, it } from 'vitest';

import {
  acpModelProbeFrames,
  acpModelProbeSettled,
  acpOffersModel,
  readAcpCurrentModelId,
  readAcpModelConfigId,
  readAcpModelProbe,
  readAcpModels,
} from './acp-models';

/**
 * A `session/new` result carrying the PRE-1.0 `models` block — the carrier ACP
 * removed at schema v1.16.0 and real agents still send.
 */
function sessionResult(
  models: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { sessionId: 's1', ...(models ? { models } : {}) };
}

const OPUS = 'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]';
const SONNET = 'claude-sonnet-5[thinking=true,context=300k,effort=high]';

/**
 * A `session/new` result carrying the ACP 1.0 `configOptions[]` block, shaped
 * as cursor-agent 2026.08.04-aaa8809 actually sends it — the `mode` option
 * first, so a reader keyed on position rather than on `category` is caught.
 */
function configOptionsResult(
  modelOption: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    sessionId: 's1',
    configOptions: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'agent',
        options: [{ value: 'agent', name: 'Agent' }],
      },
      ...(modelOption ? [modelOption] : []),
    ],
  };
}

function stdoutLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

describe('readAcpModels', () => {
  it('reads availableModels by modelId, the key ACP actually uses', () => {
    const models = readAcpModels(
      sessionResult({
        currentModelId: SONNET,
        availableModels: [
          { modelId: OPUS, name: 'Opus 5' },
          { modelId: SONNET, name: 'Sonnet 5' },
        ],
      }),
    );

    expect(models).toEqual([
      { modelId: OPUS, name: 'Opus 5' },
      { modelId: SONNET, name: 'Sonnet 5' },
    ]);
  });

  it('drops an entry keyed `id`, the way the sibling modes block is keyed', () => {
    // The failure this pins is silent: `modes.availableModes` entries carry
    // `id`, so reading a MODEL entry the same way yields undefined for every
    // row and produces an empty picker rather than an error.
    expect(
      readAcpModels(
        sessionResult({ availableModels: [{ id: OPUS, name: 'Opus 5' }] }),
      ),
    ).toEqual([]);
  });

  it('falls back to the id when the agent names no label', () => {
    expect(
      readAcpModels(sessionResult({ availableModels: [{ modelId: OPUS }] })),
    ).toEqual([{ modelId: OPUS, name: OPUS }]);
  });

  it('reads a missing models block as silence, not as an empty vocabulary', () => {
    // A `session/load` reply carries no models block at all.
    expect(readAcpModels(sessionResult(undefined))).toEqual([]);
    expect(readAcpCurrentModelId(sessionResult(undefined))).toBeNull();
  });

  it('survives a non-record reply rather than throwing into the turn', () => {
    expect(readAcpModels(null)).toEqual([]);
    expect(readAcpModels('nonsense')).toEqual([]);
  });
});

describe('the ACP 1.0 configOptions carrier', () => {
  const modelOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: SONNET,
    options: [
      { value: OPUS, name: 'Opus 5' },
      { value: SONNET, name: 'Sonnet 5' },
    ],
  };

  it('reads models out of the model-category option', () => {
    expect(readAcpModels(configOptionsResult(modelOption))).toEqual([
      { modelId: OPUS, name: 'Opus 5' },
      { modelId: SONNET, name: 'Sonnet 5' },
    ]);
    expect(readAcpCurrentModelId(configOptionsResult(modelOption))).toBe(
      SONNET,
    );
  });

  it('identifies the option by `category`, not by its id', () => {
    // The ids are the AGENT's namespace and the categories are the PROTOCOL's.
    // Cursor happens to name this option `model` too, so keying on the id
    // would pass here and list nothing against an agent that names it
    // `model_selection` — a silently empty picker, not an error.
    const renamed = { ...modelOption, id: 'model_selection' };
    expect(readAcpModels(configOptionsResult(renamed))).toHaveLength(2);
    expect(readAcpModelConfigId(configOptionsResult(renamed))).toBe(
      'model_selection',
    );
  });

  it('prefers configOptions over the legacy block when the agent sends both', () => {
    // cursor-agent 2026.08.04-aaa8809 sends BOTH. Only one may be believed, or
    // the picker offers ids from one carrier and the driver applies the other.
    const both = {
      ...configOptionsResult(modelOption),
      models: {
        currentModelId: OPUS,
        availableModels: [{ modelId: 'stale-legacy-id', name: 'Legacy' }],
      },
    };
    expect(readAcpModels(both)).toEqual([
      { modelId: OPUS, name: 'Opus 5' },
      { modelId: SONNET, name: 'Sonnet 5' },
    ]);
    expect(readAcpCurrentModelId(both)).toBe(SONNET);
  });

  it('falls back to the legacy block when the reply carries no model option', () => {
    // An agent predating schema v1.16.0 sends `models` alone; reading only
    // configOptions would report it as having no models at all.
    const legacyOnly = {
      ...configOptionsResult(undefined),
      models: { currentModelId: OPUS, availableModels: [{ modelId: OPUS }] },
    };
    expect(readAcpModels(legacyOnly)).toEqual([{ modelId: OPUS, name: OPUS }]);
    expect(readAcpCurrentModelId(legacyOnly)).toBe(OPUS);
    expect(readAcpModelConfigId(legacyOnly)).toBeNull();
  });

  it('falls back to the option value when the agent names no label', () => {
    expect(
      readAcpModels(
        configOptionsResult({
          id: 'model',
          category: 'model',
          options: [{ value: OPUS }],
        }),
      ),
    ).toEqual([{ modelId: OPUS, name: OPUS }]);
  });

  it('reports no configId for a reply with no configOptions at all', () => {
    expect(readAcpModelConfigId(sessionResult(undefined))).toBeNull();
    expect(readAcpModelConfigId(null)).toBeNull();
  });
});

describe('acpOffersModel', () => {
  const result = sessionResult({
    currentModelId: SONNET,
    availableModels: [{ modelId: OPUS, name: 'Opus 5' }],
  });

  it('accepts a listed model', () => {
    expect(acpOffersModel(result, OPUS)).toBe(true);
  });

  it('accepts the model the session is already on, unlisted or not', () => {
    expect(acpOffersModel(result, SONNET)).toBe(true);
  });

  it('refuses one the agent never named', () => {
    expect(acpOffersModel(result, 'gpt-5.2[reasoning=medium]')).toBe(false);
  });
});

describe('acpModelProbeFrames', () => {
  const frames = acpModelProbeFrames({
    cwd: '/proj',
    clientName: 'geniro',
    clientVersion: '1.2.3',
  });
  const parsed = frames.map(
    (frame) => JSON.parse(frame) as Record<string, unknown>,
  );

  it('pipelines initialize and session/new without awaiting the first reply', () => {
    // Both frames go out together — the read would otherwise cost a round-trip
    // on every cold listing to learn what the ordered stream guarantees.
    expect(parsed.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
    ]);
  });

  it('newline-terminates each frame so the two do not run together', () => {
    // The option writes these verbatim; an unterminated frame would arrive as
    // one unparseable line with the next.
    expect(frames.every((frame) => frame.endsWith('\n'))).toBe(true);
  });

  it('lends the agent neither filesystem nor terminal', () => {
    const capabilities = (
      parsed[0]!.params as { clientCapabilities: Record<string, unknown> }
    ).clientCapabilities;
    expect(capabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  it('registers no MCP servers — a probe sends no prompt and needs no tools', () => {
    expect(parsed[1]!.params).toEqual({ cwd: '/proj', mcpServers: [] });
  });
});

describe('the probe read', () => {
  const reply = stdoutLine({
    jsonrpc: '2.0',
    id: 2,
    result: sessionResult({
      currentModelId: SONNET,
      availableModels: [{ modelId: OPUS, name: 'Opus 5' }],
    }),
  });

  it('does not settle on the initialize reply alone', () => {
    const stdout = stdoutLine({ jsonrpc: '2.0', id: 1, result: {} });
    expect(acpModelProbeSettled(stdout)).toBe(false);
  });

  it('does not settle on a partial trailing line', () => {
    const stdout = `${stdoutLine({ jsonrpc: '2.0', id: 1, result: {} })}${reply.slice(0, 20)}`;
    expect(acpModelProbeSettled(stdout)).toBe(false);
  });

  it('settles on the session reply and reports its models', () => {
    const stdout = stdoutLine({ jsonrpc: '2.0', id: 1, result: {} }) + reply;
    expect(acpModelProbeSettled(stdout)).toBe(true);
    expect(readAcpModelProbe(stdout)).toEqual([
      { modelId: OPUS, name: 'Opus 5' },
    ]);
  });

  it('settles on an ERROR reply too, reporting no models', () => {
    // An unauthenticated CLI is the ordinary case. Waiting on it would spend
    // the whole deadline to reach the same empty list.
    const stdout = stdoutLine({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32000, message: 'not authenticated' },
    });
    expect(acpModelProbeSettled(stdout)).toBe(true);
    expect(readAcpModelProbe(stdout)).toEqual([]);
  });

  it('ignores the agent’s own non-JSON chatter', () => {
    const stdout = `starting cursor-agent…\n${reply}`;
    expect(acpModelProbeSettled(stdout)).toBe(true);
    expect(readAcpModelProbe(stdout)).toHaveLength(1);
  });
});
