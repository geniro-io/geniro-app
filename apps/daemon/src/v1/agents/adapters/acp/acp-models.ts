import { asArray, asRecord, asString } from '../../utils/json-util';
import {
  ACP_AGENT_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpModel,
} from './acp.types';
import { classifyMessage, encodeRequest } from './acp-jsonrpc';

/**
 * The `models` block of a `session/new` reply, read defensively.
 *
 * Shared by the two readers that must agree about it: the per-turn driver,
 * which decides whether the turn's model can be applied, and an adapter's
 * model listing, which spawns a handshake for no other purpose than this block.
 * Reading it twice would let a picker offer ids the driver then refuses.
 *
 * Absence means "the agent said nothing", never "the agent has no models" —
 * which is why every caller treats an empty result as unknown rather than as a
 * refusal. A `session/load` reply is not KNOWN to carry this block: unlike the
 * `session/new` shape above, that has never been observed against a signed-in
 * binary here, so nothing may be concluded from its silence.
 */
export function readAcpModels(sessionResult: unknown): AcpModel[] {
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
  const models = asRecord(asRecord(sessionResult)?.models);
  return models ? asString(models.currentModelId) : null;
}

/**
 * Whether the session reply offers `modelId`.
 *
 * Checked before sending `session/set_model`, for the same reason
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
