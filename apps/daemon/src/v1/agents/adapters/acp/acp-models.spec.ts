import { describe, expect, it } from 'vitest';

import {
  acpModelProbeFrames,
  acpModelProbeSettled,
  acpOffersModel,
  readAcpCurrentModelId,
  readAcpModelProbe,
  readAcpModels,
} from './acp-models';

/** A `session/new` result carrying the models block, as cursor reports it. */
function sessionResult(
  models: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { sessionId: 's1', ...(models ? { models } : {}) };
}

const OPUS = 'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]';
const SONNET = 'claude-sonnet-5[thinking=true,context=300k,effort=high]';

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
