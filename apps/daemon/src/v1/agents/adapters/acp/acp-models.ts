import { asArray, asRecord, asString } from '../../utils/json-util';
import {
  ACP_AGENT_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpConfigOption,
  type AcpModel,
} from './acp.types';
import { classifyMessage, encodeRequest } from './acp-jsonrpc';

/**
 * The protocol's own name for the config option that selects a model.
 * `category`, not `id` — see {@link AcpConfigOption}.
 */
export const ACP_MODEL_CONFIG_CATEGORY = 'model';

/**
 * The `configOptions[]` entry of category `model`, or null when the reply
 * carries none. This is the ACP 1.0 carrier for the model vocabulary; the
 * `models` block below is its removed pre-1.0 predecessor.
 */
function readModelConfigOption(sessionResult: unknown): AcpConfigOption | null {
  for (const entry of asArray(asRecord(sessionResult)?.configOptions)) {
    const record = asRecord(entry);
    const id = record ? asString(record.id) : null;
    if (record === null || id === null || id === '') {
      continue;
    }
    if (asString(record.category) !== ACP_MODEL_CONFIG_CATEGORY) {
      continue;
    }
    const options: AcpConfigOption['options'] = [];
    for (const option of asArray(record.options)) {
      const optionRecord = asRecord(option);
      const value = optionRecord ? asString(optionRecord.value) : null;
      if (value === null || value === '') {
        continue;
      }
      options.push({ value, name: asString(optionRecord?.name) || value });
    }
    return {
      id,
      name: asString(record.name),
      category: ACP_MODEL_CONFIG_CATEGORY,
      currentValue: asString(record.currentValue),
      options,
    };
  }
  return null;
}

/**
 * One `configOptions[]` entry by its own `id`, or null when the reply carries
 * none — the parameter counterpart of {@link readModelConfigOption}, which
 * keys on `category` because the model option's category is the PROTOCOL's
 * vocabulary while every other option's is the agent's.
 *
 * A model's parameters are keyed by id for exactly that reason: cursor spells
 * `effort` and `thinking` under the category `thought_level` and `context` and
 * `fast` under `model_config`, so a category key would fold two unrelated
 * settings together while the ids are what the turn actually sends.
 */
export function readAcpConfigOption(
  sessionResult: unknown,
  configId: string,
): AcpConfigOption | null {
  return (
    readAcpConfigOptions(sessionResult).find(
      (option) => option.id === configId,
    ) ?? null
  );
}

/**
 * EVERY `configOptions[]` entry the reply carries, in the agent's own order.
 *
 * The plural of {@link readAcpConfigOption}, and the reader for a consumer that
 * does not know in advance which options exist — a model's parameters are the
 * agent's vocabulary, so the only way to surface a setting nobody here has
 * heard of is to enumerate and subtract (see `AgentModelParameter`). Written as
 * the primitive with the singular reader built on it, so the two cannot come to
 * disagree about how one entry is read.
 *
 * An entry with no usable `id` is dropped: it can never be set, so offering it
 * would be a control with nothing behind it. An entry with no `options` is
 * KEPT — that is the agent naming an axis whose vocabulary it did not send, and
 * the callers each decide what to do about it (both of them, today, treat an
 * empty list as "no choice here").
 */
export function readAcpConfigOptions(
  sessionResult: unknown,
): AcpConfigOption[] {
  const found: AcpConfigOption[] = [];
  for (const entry of asArray(asRecord(sessionResult)?.configOptions)) {
    const record = asRecord(entry);
    const id = record ? asString(record.id) : null;
    if (record === null || id === null || id === '') {
      continue;
    }
    const options: AcpConfigOption['options'] = [];
    for (const option of asArray(record.options)) {
      const optionRecord = asRecord(option);
      const value = optionRecord ? asString(optionRecord.value) : null;
      if (value === null || value === '') {
        continue;
      }
      options.push({ value, name: asString(optionRecord?.name) || value });
    }
    found.push({
      id,
      name: asString(record.name),
      category: asString(record.category),
      currentValue: asString(record.currentValue),
      options,
    });
  }
  return found;
}

/**
 * The models a `session/new` reply offers, read defensively out of whichever
 * carrier the agent used.
 *
 * TWO carriers, because ACP replaced one with the other and the binaries did
 * not follow at once. `configOptions[]` (category `model`) is the ACP 1.0 form
 * and is preferred; `models.availableModels` is the pre-1.0 form, removed from
 * the schema at v1.16.0 on 2026-06-24 but still emitted by real agents —
 * cursor-agent 2026.08.04-aaa8809 sends BOTH, with identical contents. So the
 * choice is made from what a reply ACTUALLY carries, never from a version
 * number: an agent is asked what it offers and believed.
 *
 * Shared by the two readers that must agree about it: the per-turn driver,
 * which decides whether the turn's model can be applied, and an adapter's
 * model listing, which spawns a handshake for no other purpose than this block.
 * Reading it twice would let a picker offer ids the driver then refuses.
 *
 * Absence means "the agent said nothing", never "the agent has no models" —
 * which is why every caller treats an empty result as unknown rather than as a
 * refusal. A `session/load` reply is not KNOWN to carry either block: unlike
 * the `session/new` shape above, that has never been observed against a
 * signed-in binary here, so nothing may be concluded from its silence.
 */
export function readAcpModels(sessionResult: unknown): AcpModel[] {
  const configOption = readModelConfigOption(sessionResult);
  if (configOption !== null) {
    return configOption.options.map((option) => ({
      modelId: option.value,
      name: option.name,
    }));
  }
  const models = asRecord(asRecord(sessionResult)?.models);
  if (!models) {
    return [];
  }
  const found: AcpModel[] = [];
  for (const entry of asArray(models.availableModels)) {
    const record = asRecord(entry);
    const modelId = record ? asString(record.modelId) : null;
    if (modelId === null || modelId === '') {
      continue;
    }
    // The agent's display name when it gave one, else the id itself: a row
    // with a blank label is unpickable, and the id is always meaningful.
    //
    // `||`, not `??`: `asString` passes `''` straight through — which is why
    // `modelId` is checked against `''` explicitly two lines up — so `??`
    // would catch only a missing name and let an EMPTY one render the exact
    // blank row this line exists to prevent.
    found.push({ modelId, name: asString(record?.name) || modelId });
  }
  return found;
}

/** The model the session is already on, or null when none was reported. */
export function readAcpCurrentModelId(sessionResult: unknown): string | null {
  const configOption = readModelConfigOption(sessionResult);
  if (configOption !== null) {
    return configOption.currentValue;
  }
  const models = asRecord(asRecord(sessionResult)?.models);
  return models ? asString(models.currentModelId) : null;
}

/**
 * The `configId` to send `session/set_config_option` with, or null when this
 * agent offers no model config option and must be told the pre-1.0 way.
 *
 * This is the WHOLE version negotiation, and it is deliberately one question
 * asked of the reply rather than a capability flag or a version comparison:
 * an agent that enumerated its models under `configOptions` is by construction
 * an agent that implements the method which sets them.
 */
export function readAcpModelConfigId(sessionResult: unknown): string | null {
  return readModelConfigOption(sessionResult)?.id ?? null;
}

/**
 * Whether the session reply offers `modelId`.
 *
 * Checked before applying the model, for the same reason
 * {@link import('./acp-driver').AcpTurnDriver} checks a mode first: an id the
 * agent does not offer earns an error reply, so asking costs a round-trip to
 * be refused and produces a failure event the turn would have to explain.
 */
export function acpOffersModel(
  sessionResult: unknown,
  modelId: string,
): boolean {
  if (readAcpCurrentModelId(sessionResult) === modelId) {
    return true;
  }
  return readAcpModels(sessionResult).some(
    (model) => model.modelId === modelId,
  );
}

/** Request ids the model probe uses. Local: nothing outside it sends these. */
const PROBE_INITIALIZE_ID = 1;
const PROBE_SESSION_ID = 2;

/**
 * The two frames that make an agent report its models, and nothing else.
 *
 * ACP has no "list models" method — the vocabulary is only ever reported as
 * part of a `session/new` reply — so obtaining one means opening a session.
 * That is cheap and leaves nothing behind: an ACP session is not in the CLI's
 * own chat store (probe-verified on cursor-agent 2026.07.23-e383d2b, which is
 * also why this transport declares handoff unavailable), and no prompt is ever
 * sent, so the agent does no work and bills nothing.
 *
 * Both frames go out together rather than waiting for the `initialize` reply.
 * Probed on 2026.08.04-aaa8809: the agent reads one ordered stream and answers
 * the pipelined `session/new` normally, so waiting would add a round-trip to
 * every cold listing to learn what the ordering already guarantees.
 */
export function acpModelProbeFrames(input: {
  cwd: string;
  clientName: string;
  clientVersion: string;
  /**
   * The same `clientCapabilities._meta` the TURN declares, and it must be the
   * same: on cursor that bag decides whether models are enumerated as bare names
   * or as bracketed variant ids, so a probe that omitted it would fill the
   * picker with ids no turn could apply.
   */
  clientMeta?: Readonly<Record<string, unknown>>;
}): string[] {
  return [
    encodeRequest(PROBE_INITIALIZE_ID, ACP_AGENT_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Same refusals the turn path declares: this client lends the agent
      // neither its filesystem nor its terminal, and a probe has even less
      // business doing so than a turn.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(input.clientMeta ? { _meta: input.clientMeta } : {}),
      },
      clientInfo: { name: input.clientName, version: input.clientVersion },
    }),
    encodeRequest(PROBE_SESSION_ID, ACP_AGENT_METHODS.sessionNew, {
      cwd: input.cwd,
      mcpServers: [],
    }),
  ];
}

/**
 * The probe's `session/new` reply once it has arrived — `settled` says whether
 * the read can stop, `result` is the payload to read models out of.
 *
 * An ERROR reply settles too, with a null result. The agent has answered; it
 * just answered no (an unauthenticated CLI is the ordinary case), and treating
 * that as "keep waiting" would spend the whole deadline before reporting the
 * same empty list.
 */
function probeSessionReply(stdout: string): {
  settled: boolean;
  result: unknown;
} {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partial trailing line, or the agent's own non-JSON chatter.
      continue;
    }
    const message = classifyMessage(parsed);
    if (message.kind === 'response' && message.id === PROBE_SESSION_ID) {
      return { settled: true, result: message.result };
    }
    if (message.kind === 'error' && message.id === PROBE_SESSION_ID) {
      return { settled: true, result: null };
    }
  }
  return { settled: false, result: null };
}

/** Whether {@link acpModelProbeFrames}' answer is fully on stdout yet. */
export function acpModelProbeSettled(stdout: string): boolean {
  return probeSessionReply(stdout).settled;
}

/** The models a completed probe reported; empty when it reported none. */
export function readAcpModelProbe(stdout: string): AcpModel[] {
  return readAcpModels(probeSessionReply(stdout).result);
}

/**
 * One config option's enumerated values, read off a completed probe.
 *
 * The same two frames as {@link acpModelProbeFrames} answer this — a
 * `session/new` reply carries the CURRENT model's options alongside its model
 * list — so a caller that wants one model's vocabulary opens the handshake on
 * that model (see `seedCursorProfile`'s `model`) rather than switching
 * afterwards and paying a second round trip.
 *
 * Null means the reply said NOTHING about this option, which is not the same as
 * a model that has none: a probe that failed, an agent that enumerates no
 * config options, and a genuinely absent option all have to be told apart by
 * the caller, and only the last is a reason to hide a control.
 */
export function readAcpConfigOptionProbe(
  stdout: string,
  configId: string,
): AcpConfigOption | null {
  const { settled, result } = probeSessionReply(stdout);
  return settled ? readAcpConfigOption(result, configId) : null;
}

/**
 * {@link readAcpConfigOptions} over a raw probe's stdout — the plural twin of
 * {@link readAcpConfigOptionProbe}. An unsettled probe yields nothing, which
 * the caller must read as "not asked" rather than as "no options".
 */
export function readAcpConfigOptionsProbe(stdout: string): AcpConfigOption[] {
  const { settled, result } = probeSessionReply(stdout);
  return settled ? readAcpConfigOptions(result) : [];
}

/** Whether a completed probe enumerated ANY config options at all. */
export function acpProbeEnumeratedConfigOptions(stdout: string): boolean {
  const { settled, result } = probeSessionReply(stdout);
  return settled && asArray(asRecord(result)?.configOptions).length > 0;
}
