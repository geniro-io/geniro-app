import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSearchDb } from '../../agents/__tests__/chat-search-db';
import { GENIRO_MCP_CALL_TOOLS } from '../../agents/adapters/adapter.types';
import {
  HISTORY_RESULT_PREFACE,
  HOST_ANALYZED_THREAD_TOOL,
  HOST_ARTIFACT_TOOL,
  HOST_BOARD_TOOLS,
  HOST_CHART_TOOL,
  HOST_COMPARISON_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_GALLERY_TOOL,
  HOST_METRICS_TOOL,
  HOST_NOTIFY_TOOL,
  HOST_PATCH_TOOL,
  HOST_PLAN_TOOL,
  HOST_PUBLISH_ACTION_TOOL,
  HOST_QUESTION_TOOL,
  HOST_READ_CHAT_CONTEXT_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
  HOST_REMOVE_ACTION_TOOL,
  HOST_SEARCH_CHATS_TOOL,
  HOST_WORKFLOW_CHANGE_TOOL,
  MAX_ARTIFACT_HTML_BYTES,
} from '../../agents/chat.types';
import { ChatSearchIndexDao } from '../../agents/dao/chat-search-index.dao';
import { ActionBroker } from '../../agents/services/action.broker';
import { AnalysisBroker } from '../../agents/services/analysis.broker';
import { ArtifactBroker } from '../../agents/services/artifact.broker';
import { ChartBroker } from '../../agents/services/chart.broker';
import { ComparisonBroker } from '../../agents/services/comparison.broker';
import { FindingsReportBroker } from '../../agents/services/findings-report.broker';
import { GalleryBroker } from '../../agents/services/gallery.broker';
import { GlobalChatSearchService } from '../../agents/services/global-chat-search.service';
import { MetricsBroker } from '../../agents/services/metrics.broker';
import { NotifyBroker } from '../../agents/services/notify.broker';
import { PatchBroker } from '../../agents/services/patch.broker';
import { PlanBroker } from '../../agents/services/plan.broker';
import type { ThreadReaderService } from '../../agents/services/thread-reader.service';
import { UserQuestionBroker } from '../../agents/services/user-question.broker';
import {
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGES,
  megabytes,
} from '../../agents/utils/artifact-image-policy';
import { ARTIFACT_PAGE_CSP } from '../../agents/utils/artifact-page';
import {
  ARTIFACT_KIT_STYLE,
  ARTIFACT_TAILWIND_THEME,
  ARTIFACT_TOKEN_NAMES,
} from '../../agents/utils/artifact-runtime';
import { MAX_HOST_QUESTION_TITLE_LENGTH } from '../../agents/utils/host-question';
import {
  ALWAYS_LOADED_TOOL_META,
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
  MIN_AWAIT_TIMEOUT_MS,
  type RunCallCapability,
  type TaskBoardHandler,
  type WorkflowAgentNode,
} from '../../graphs/graphs.types';
import { CallBroker } from '../../graphs/services/call-broker.service';
import { TaskBoardBroker } from '../../graphs/services/task-board.broker';
import type { WorkflowChangeService } from '../../graphs/services/workflow-change.service';
import {
  ANSWERING_A_CALL,
  ANSWERING_WITH_CALLS_OUT,
} from '../../graphs/utils/callee-text';
import { callerKey } from '../../graphs/utils/caller-key';
import { AgentKind } from '../../runs/runs.types';
import type { ShareService } from '../../shares/services/share.service';
import type { AgentShareOutcome } from '../../shares/shares.types';
import { BOARD_TOOLS } from '../../tasks/utils/board-tools';
import { createMcpTools } from '../tools/mcp-tools';
import { proposePatchInstructions } from '../tools/propose-patch/propose-patch.instructions';
import { proposePlanInstructions } from '../tools/propose-plan/propose-plan.instructions';
import { McpServerService } from './mcp-server.service';

/** One row of `tools/list`, as the description audit reads it. */
type ToolListing = {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, { description?: string }> };
};

const HELPER: WorkflowAgentNode = {
  id: 'helper',
  kind: 'agent',
  name: 'Helper',
  agent: 'claude',
  approval: 'auto',
  description: 'Researches a topic and reports what it found.',
  // Private instructions — a caller must never be shown this (see below).
  role: 'You help with research. Always start by reading SECRET_PLAYBOOK.md.',
};

function broker(): CallBroker {
  const capability: RunCallCapability = {
    calleesOf: new Map([['orch', [HELPER]]]),
    launchCalleeTurn: async () => ({
      status: 'completed',
      finalText: 'research done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    }),
    persistItem: () => {},
    isCancelled: () => false,
    isSuperseded: () => false,
    toolCallDeadlineMs: () => null,
    cancelCalleeTurn: () => false,
    messageCallee: () => ({ delivered: false, reason: 'not_started' }),
    isNodeLive: () => true,
    tellLiveNode: () => false,
    wakeNode: () => false,
  };
  const instance = new CallBroker();
  instance.registerRun('run-1', capability);
  return instance;
}
function service(
  callBroker = broker(),
  questions = new UserQuestionBroker(),
  findings = new FindingsReportBroker(),
  charts = new ChartBroker(),
  patches = new PatchBroker(),
  plans = new PlanBroker(),
  metrics = new MetricsBroker(),
  comparisons = new ComparisonBroker(),
  galleries = new GalleryBroker(),
  artifacts = new ArtifactBroker(),
  notices = new NotifyBroker(),
  taskBoard = new TaskBoardBroker(),
  // Never asked by the cases that pass none; the history cases hand a real one.
  chatSearch = new GlobalChatSearchService({} as ChatSearchIndexDao),
  analysis = new AnalysisBroker(),
  // Never asked by the cases that list tools; the analysis cases hand doubles.
  threads = {} as ThreadReaderService,
  workflowChanges = {} as WorkflowChangeService,
  shares = fakeShares(false).service,
  actions = new ActionBroker(),
): McpServerService {
  return new McpServerService(
    createMcpTools({
      calls: callBroker,
      questions,
      findings,
      charts,
      metrics,
      comparisons,
      galleries,
      artifacts,
      actions,
      patches,
      plans,
      notices,
      board: taskBoard,
      history: chatSearch,
      analysis,
      threads,
      workflowChanges,
      shares,
    }),
    {
      token: 'launch',
      version: '9.9.9',
      startedAt: 0,
      port: 4870,
    },
  );
}

/**
 * A service whose only registered host tool is the patch one.
 *
 * Named rather than spelled out at five call sites: `propose_patch` is the
 * fifth positional argument, so reaching it means naming four empty brokers,
 * and a reader would have to count them to see which tool a test is about.
 */
/**
 * A service with EVERY host sink registered, so `tools/list` returns the whole
 * render family at once. What the description tests below are written against:
 * a model reads these as one list, not one tool at a time, which is exactly how
 * the boundary claims came to be missing from one side of a pair.
 */
async function everyHostTool(): Promise<ToolListing[]> {
  const noop = async (): Promise<never> => {
    throw new Error('not called');
  };
  const questions = new UserQuestionBroker();
  const findings = new FindingsReportBroker();
  const charts = new ChartBroker();
  const patches = new PatchBroker();
  const plans = new PlanBroker();
  const metrics = new MetricsBroker();
  const comparisons = new ComparisonBroker();
  const galleries = new GalleryBroker();
  const artifacts = new ArtifactBroker();
  const notices = new NotifyBroker();
  const actions = new ActionBroker();
  for (const broker of [
    questions,
    findings,
    charts,
    patches,
    plans,
    metrics,
    comparisons,
    galleries,
    artifacts,
    notices,
    actions,
  ]) {
    broker.register('run-1', 'agent', noop as never);
  }
  const board = new TaskBoardBroker();
  board.install({ tools: () => BOARD_TOOLS, call: noop });
  const analysis = new AnalysisBroker();
  analysis.register('run-1', 'agent', {
    turn: {
      analysisRunId: 'run-1',
      sourceRunId: 'source',
      snapshotSeq: 0,
      sourceWorking: false,
    },
    report: noop,
    mark: noop,
  });
  const { json } = await post(
    service(
      new CallBroker(),
      questions,
      findings,
      charts,
      patches,
      plans,
      metrics,
      comparisons,
      galleries,
      artifacts,
      notices,
      board,
      undefined,
      analysis,
      undefined,
      undefined,
      undefined,
      actions,
    ),
    'run-1',
    'agent',
    rpc('tools/list', {}),
  );
  return (json().result as { tools: ToolListing[] }).tools;
}

/** A service whose only registered host sink is the action one. */
function actionService(actions: ActionBroker): McpServerService {
  return service(
    new CallBroker(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
}

function patchService(patches: PatchBroker): McpServerService {
  return service(
    new CallBroker(),
    new UserQuestionBroker(),
    new FindingsReportBroker(),
    new ChartBroker(),
    patches,
  );
}

function galleryService(galleries: GalleryBroker): McpServerService {
  return service(
    new CallBroker(),
    new UserQuestionBroker(),
    new FindingsReportBroker(),
    new ChartBroker(),
    new PatchBroker(),
    new PlanBroker(),
    new MetricsBroker(),
    new ComparisonBroker(),
    galleries,
  );
}

/** A ShareService double: the user's switch, and every agent share it was asked for. */
function fakeShares(
  agentsMayShare: boolean,
  outcome: AgentShareOutcome = {
    kind: 'shared',
    url: 'https://pages.example.com/x/index.html#k=KEY',
  },
) {
  const asked: { artifactId: string; title: string; remote: boolean }[] = [];
  const service = {
    agentsMayShare: () => agentsMayShare,
    shareForAgent: (
      input: { artifactId: string; title: string },
      remote: boolean,
    ) => {
      asked.push({ artifactId: input.artifactId, title: input.title, remote });
      return Promise.resolve(outcome);
    },
  } as unknown as ShareService;
  return { service, asked };
}

function artifactService(
  artifacts: ArtifactBroker,
  shares?: ShareService,
): McpServerService {
  return service(
    new CallBroker(),
    new UserQuestionBroker(),
    new FindingsReportBroker(),
    new ChartBroker(),
    new PatchBroker(),
    new PlanBroker(),
    new MetricsBroker(),
    new ComparisonBroker(),
    new GalleryBroker(),
    artifacts,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    shares,
  );
}

/**
 * Drive the service over a REAL loopback http server: the SDK's Node
 * transport converts IncomingMessage → web Request via @hono/node-server,
 * which needs a genuine socket-backed request — a hand-built fake gets a
 * blank 400 from the conversion layer, not from our code.
 */
async function post(
  target: McpServerService,
  runId: string,
  nodeId: string,
  payload: unknown,
  /** The route's conversation segment, for a turn answering a call. */
  conversationId: string | null = null,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: () => Record<string, unknown> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : undefined;
      const fastifyReq = {
        raw: req,
        body,
        headers: req.headers,
      } as unknown as FastifyRequest;
      const fastifyReply = {
        raw: res,
        hijack: () => {},
      } as unknown as FastifyReply;
      void target.handlePost(
        runId,
        nodeId,
        fastifyReq,
        fastifyReply,
        conversationId,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/mcp/${runId}/${nodeId}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(payload),
      },
    );
    const text = await res.text();
    return {
      status: res.status,
      json: () => JSON.parse(text) as Record<string, unknown>,
    };
  } finally {
    server.close();
  }
}

function rpc(method: string, params: unknown, id = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * {@link post}'s sibling for the one case that needs TWO requests against the
 * same service while the first is still in flight: a cancellation arrives on
 * its own POST, so `post` — which closes its server before returning — cannot
 * express it.
 */
async function serving(target: McpServerService): Promise<{
  send: (payload: unknown) => Promise<Response>;
  close: () => void;
}> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : undefined;
      void target.handlePost(
        'run-1',
        'agent',
        { raw: req, body, headers: req.headers } as unknown as FastifyRequest,
        { raw: res, hijack: () => {} } as unknown as FastifyReply,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    send: (payload: unknown) =>
      fetch(`http://127.0.0.1:${port}/v1/mcp/run-1/agent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(payload),
      }),
    close: () => server.close(),
  };
}

describe('McpServerService', () => {
  it('answers initialize with the daemon server info (stateless, plain JSON)', async () => {
    const { status, json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude', version: '2.1.201' },
      }),
    );
    expect(status).toBe(200);
    const result = json().result as Record<string, unknown>;
    expect(result.serverInfo).toMatchObject({
      name: 'geniro-daemon',
      version: '9.9.9',
    });
  });

  it('lists every call tool, naming the callable agents', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as { tools: { name: string; description: string }[] }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      ...GENIRO_MCP_CALL_TOOLS,
      HOST_SEARCH_CHATS_TOOL,
      HOST_READ_CHAT_CONTEXT_TOOL,
    ]);
    expect(tools[0]!.description).toContain('Helper');
    // Each callee's own description is the caller's routing signal — the
    // caller picks by what an agent says it does.
    expect(tools[0]!.description).toContain(
      'Researches a topic and reports what it found.',
    );
    // ...and its ROLE stays private. Leaking it is what forced every caller's
    // role to restate its team's internals.
    expect(tools[0]!.description).not.toContain('SECRET_PLAYBOOK');
    // The question-envelope guidance rides the descriptions: confident-answer
    // vs escalate, and the await_agent follow-up.
    expect(tools[0]!.description).toContain('"question"');
    expect(tools[2]!.description).toContain('ask the user');
    expect(tools[2]!.description).toContain('await_agent');
  });

  it('offers await_agent a bounded wait, and says a pending answer is not a failure', async () => {
    // The control that makes "wait or work in parallel" a decision the caller
    // can take AFTER reading a callee's first answer — useless if the schema
    // never mentions it, since a model calls what it is told about. The bounds
    // are asserted against the LIVE constants: the ceiling is a measurement of
    // the transport (the caller's HTTP client cuts an idle request at five
    // minutes), so a literal here would go on passing after the real one moved.
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: {
          name: string;
          description: string;
          inputSchema: {
            properties: Record<string, { minimum?: number; maximum?: number }>;
          };
        }[];
      }
    ).tools;
    const await_ = tools.find((t) => t.name === 'await_agent')!;
    expect(await_.inputSchema.properties.timeout_ms).toMatchObject({
      minimum: MIN_AWAIT_TIMEOUT_MS,
      maximum: MAX_AWAIT_TIMEOUT_MS,
    });
    // An omitted window is no longer "block forever", and a model that reads
    // the old promise waits past the transport again — so the description has
    // to say what omitting it now means, and in which unit.
    expect(
      (await_.inputSchema.properties.timeout_ms as { description?: string })
        .description,
    ).toContain(`${DEFAULT_AWAIT_TIMEOUT_MS}ms`);
    expect(
      (await_.inputSchema.properties.timeout_ms as { description?: string })
        .description,
    ).toContain('MILLISECONDS');
    // The half a model gets wrong on its own: `pending` looks like a failure
    // beside `ok`, and a caller that reads it as one re-issues a call that is
    // running perfectly well — the descriptions are the routing logic here.
    expect(await_.description).toContain('"pending"');
    expect(await_.description).toContain('not a failure');
    // Waiting on ALL calls is only used if the model is told it exists — and
    // call_id stops being required for it.
    expect(await_.description).toContain('OMIT call_id');
    expect(
      (await_.inputSchema as { required?: string[] }).required ?? [],
    ).not.toContain('call_id');
  });

  it('steers a caller to ASYNC calls and tells it it is woken when one finishes or asks', async () => {
    // REPORTED: a Manager making sync calls sat idle for the whole of each
    // callee's work instead of taking other tasks. The runtime already starts
    // a new turn for a caller whose async call finishes or asks after its turn
    // ended — a model only uses that if the tool says so.
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: {
          name: string;
          description: string;
          inputSchema: { properties: Record<string, { description?: string }> };
        }[];
      }
    ).tools;
    const call = tools.find((t) => t.name === 'call_agent')!;
    expect(call.description).toContain('PREFER mode "async"');
    expect(call.description).toMatch(/END YOUR TURN/);
    expect(call.description).toMatch(/started again/);
    expect(call.inputSchema.properties.mode!.description).toMatch(
      /async \(preferred\)/,
    );
    expect(tools.find((t) => t.name === 'await_agent')!.description).toMatch(
      /Do not sit in await_agent/,
    );
  });

  it('tells a CALLEE that ending its turn while its calls run does not hand back its result', async () => {
    // "End your turn" read, to a callee, as leave with what you have: an
    // Engineer handed back "the Middles are on it" as its whole answer.
    const callAgentDescription = async (conversationId: string | null) => {
      const { json } = await post(
        service(),
        'run-1',
        'orch',
        rpc('tools/list', {}),
        conversationId,
      );
      return (
        json().result as { tools: { name: string; description: string }[] }
      ).tools.find((t) => t.name === 'call_agent')!.description;
    };
    expect(await callAgentDescription('call-4')).toContain(
      `${ANSWERING_A_CALL} ${ANSWERING_WITH_CALLS_OUT}`,
    );
    // Its own conversation answers nobody, so it is told no such thing.
    expect(await callAgentDescription(null)).not.toContain(
      'You are answering a call from another agent',
    );
  });

  it('refuses a timeout_ms outside the window, or one that is not a whole number', async () => {
    // NaN is the case worth pinning rather than the merely-large one: it is
    // what a model's "5 seconds" parses to, `setTimeout` accepts it without
    // complaint and fires immediately, so an unchecked one would answer
    // `pending` on every collection and read as a callee that never gets
    // anywhere.
    for (const timeoutMs of [
      0,
      500,
      MAX_AWAIT_TIMEOUT_MS + 1,
      1.5,
      Number.NaN,
    ]) {
      const { json } = await post(
        service(),
        'run-1',
        'orch',
        rpc('tools/call', {
          name: 'await_agent',
          arguments: { call_id: 'call-1', timeout_ms: timeoutMs },
        }),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('INVALID_ARGS');
      expect(result.content[0]!.text).toContain('timeout_ms');
    }
  });

  it('keeps the three call tools LOADED in a claude caller, which a compaction otherwise unloads', async () => {
    // Deferred, a call tool's schema is gone after the first compaction and the
    // model calls it from memory — `timeout_seconds` for `timeout_ms` — so the
    // marker has to be on exactly these tools. The render tools stay deferred:
    // every always-loaded schema is paid for on every turn.
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: { name: string; _meta?: Record<string, unknown> }[];
      }
    ).tools;
    for (const name of GENIRO_MCP_CALL_TOOLS) {
      expect(tools.find((t) => t.name === name)!._meta).toEqual(
        ALWAYS_LOADED_TOOL_META,
      );
    }
  });

  it('hands call_agent’s pool member to the broker, reading "2" as 2', async () => {
    const callBroker = broker();
    const callSpy = vi
      .spyOn(callBroker, 'callAgent')
      .mockResolvedValue({ status: 'ok', result: {} });
    for (const member of [2, '2']) {
      await post(
        service(callBroker),
        'run-1',
        'orch',
        rpc('tools/call', {
          name: 'call_agent',
          arguments: { agent: 'helper', message: 'm', title: 'T', member },
        }),
      );
    }
    expect(callSpy.mock.calls.map((call) => call[2].member)).toEqual([2, 2]);
  });

  it('refuses a pool member that is not a whole number from 1', async () => {
    const callBroker = broker();
    const callSpy = vi.spyOn(callBroker, 'callAgent');
    for (const member of [0, 1.5, 'two', -1]) {
      const { json } = await post(
        service(callBroker),
        'run-1',
        'orch',
        rpc('tools/call', {
          name: 'call_agent',
          arguments: { agent: 'helper', message: 'm', title: 'T', member },
        }),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("'member'");
    }
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("refuses an argument a call tool does not read, naming the ones it does — the reported 'timeout_seconds'", async () => {
    // REPORTED: `await_agent({call_id, timeout_seconds: "180"})` was accepted
    // with the unknown key ignored, so the wait had no window and every one
    // ended five minutes later as `The operation timed out.`. The refusal has
    // to come back at once and name the real argument, since the caller has
    // lost the schema.
    const callBroker = broker();
    const awaitSpy = vi.spyOn(callBroker, 'awaitAgent');
    const callSpy = vi.spyOn(callBroker, 'callAgent');
    const answerSpy = vi.spyOn(callBroker, 'answerAgent');
    const cancelSpy = vi.spyOn(callBroker, 'cancelAgent');
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'await_agent',
        { call_id: 'call-1', timeout_seconds: '180' },
        "'timeout_ms'",
      ],
      [
        'call_agent',
        { agent: 'helper', agent_id: 'helper', message: 'm', title: 'T' },
        "'agent'",
      ],
      [
        'answer_agent',
        { call_id: 'call-1', answer: 'yes', note: 'x' },
        "'answer'",
      ],
      [
        'cancel_agent',
        { call_id: 'call-1', reason: 'withdrawn', why: 'x' },
        "'reason'",
      ],
      [
        'message_agent',
        { call_id: 'call-1', message: 'use red', text: 'x' },
        "'message'",
      ],
    ];
    for (const [name, args, named] of cases) {
      const { json } = await post(
        service(callBroker),
        'run-1',
        'orch',
        rpc('tools/call', { name, arguments: args }),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      const error = (JSON.parse(result.content[0]!.text) as { error: string })
        .error;
      expect(error).toContain('INVALID_ARGS');
      expect(error).toContain('unknown argument');
      expect(error).toContain(named);
    }
    expect(awaitSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(answerSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('accepts every argument each call tool LISTS, so the refusal cannot drift from the schema', async () => {
    // The accepted names are a second copy of the listed properties; this is
    // what fails when a property is added to a schema and not to its list —
    // the tool would otherwise refuse the very argument it advertises.
    const { json: listed } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      listed().result as {
        tools: {
          name: string;
          inputSchema: { properties: Record<string, unknown> };
        }[];
      }
    ).tools;
    for (const name of GENIRO_MCP_CALL_TOOLS) {
      const properties = Object.keys(
        tools.find((t) => t.name === name)!.inputSchema.properties,
      );
      const args = Object.fromEntries(properties.map((key) => [key, 1]));
      const { json } = await post(
        service(),
        'run-1',
        'orch',
        rpc('tools/call', { name, arguments: args }),
      );
      const text = (json().result as { content: { text: string }[] })
        .content[0]!.text;
      expect(text).not.toContain('unknown argument');
    }
  });

  it('withholds ask_user_question from a node no turn can ask through', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain(HOST_QUESTION_TOOL);
  });

  it('offers the registered question tool and history search to a chat node with no callees', async () => {
    const questions = new UserQuestionBroker();
    questions.register('run-1', 'agent', async () => ({
      status: 'answered',
      answer: 'Postgres',
    }));
    // A CHAT's node: it is registered with no call capability at all, so
    // `listCallees` is empty and the call surface would be three tools naming
    // nobody.
    const { json } = await post(
      service(new CallBroker(), questions),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      HOST_QUESTION_TOOL,
      HOST_SEARCH_CHATS_TOOL,
      HOST_READ_CHAT_CONTEXT_TOOL,
    ]);
  });

  describe('the chat history tools', () => {
    const RUN = '00000000-0000-4000-8000-0000000000aa';
    let db: Awaited<ReturnType<typeof chatSearchDb>>;
    let history: McpServerService;

    beforeEach(async () => {
      db = await chatSearchDb();
      await db.run(RUN, { title: 'Billing' });
      await db.item('m1', {
        runId: RUN,
        payload: JSON.stringify({ text: 'idempotency key for charges' }),
      });
      await db.ensureIndex();
      history = service(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new GlobalChatSearchService(db.dao()),
      );
    });

    afterEach(async () => {
      await db.orm.close(true);
    });

    async function call(name: string, args: unknown) {
      const { json } = await post(
        history,
        'run-1',
        'agent',
        rpc('tools/call', { name, arguments: args }),
      );
      return json().result as {
        content: { type: string; text: string }[];
        isError: boolean;
      };
    }

    it('answers a search as labelled data, then JSON', async () => {
      const result = await call(HOST_SEARCH_CHATS_TOOL, { query: 'idempot' });
      expect(result.isError).toBe(false);
      const [preface, body] = result.content[0]!.text.split('\n');
      expect(preface).toBe(HISTORY_RESULT_PREFACE);
      expect(JSON.parse(body!)).toMatchObject({
        hits: [{ runId: RUN, itemId: 'm1', title: 'Billing' }],
        partialReason: null,
      });
    });

    it('refuses arguments the schema does not admit, as a tool error', async () => {
      const result = await call(HOST_SEARCH_CHATS_TOOL, { query: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^INVALID_ARGS:/);
    });

    it('refuses an argument it does not read, rather than widening the search', async () => {
      const result = await call(HOST_SEARCH_CHATS_TOOL, {
        query: 'idempot',
        run_id: RUN,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^INVALID_ARGS:/);
    });

    it('refuses an unknown argument to the context read too, and reads a null one as unset', async () => {
      const unknown = await call(HOST_READ_CHAT_CONTEXT_TOOL, {
        runId: RUN,
        itemId: 'm1',
        before_count: 1,
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]!.text).toMatch(/^INVALID_ARGS:/);

      const nulls = await call(HOST_SEARCH_CHATS_TOOL, {
        query: 'idempot',
        runId: null,
        cwd: null,
      });
      expect(nulls.isError).toBe(false);
    });

    it('answers a call with no arguments at all as invalid, not as a crash', async () => {
      const { json } = await post(
        history,
        'run-1',
        'agent',
        rpc('tools/call', { name: HOST_SEARCH_CHATS_TOOL }),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^INVALID_ARGS:/);
    });

    it('lists both without a read-only hint, so no CLI skips the card', async () => {
      const { json } = await post(
        history,
        'run-1',
        'agent',
        rpc('tools/list', {}),
      );
      const tools = (
        json().result as {
          tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
        }
      ).tools.filter((tool) =>
        [HOST_SEARCH_CHATS_TOOL, HOST_READ_CHAT_CONTEXT_TOOL].includes(
          tool.name,
        ),
      );
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBeUndefined();
      }
    });

    it('lists the arguments with the bounds, defaults and words the parser holds them to', async () => {
      const { json } = await post(
        history,
        'run-1',
        'agent',
        rpc('tools/list', {}),
      );
      const schemaOf = (name: string) =>
        (
          json().result as {
            tools: { name: string; inputSchema: Record<string, unknown> }[];
          }
        ).tools.find((tool) => tool.name === name)!.inputSchema;

      expect(schemaOf(HOST_SEARCH_CHATS_TOOL)).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            minLength: 2,
            maxLength: 500,
            description: expect.stringContaining('`OR`'),
          },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          runId: { format: 'uuid' },
          cwd: { maxLength: 4096 },
          includeArchived: { type: 'boolean', default: true },
        },
      });
      expect(schemaOf(HOST_READ_CHAT_CONTEXT_TOOL)).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['runId', 'itemId'],
        properties: {
          itemId: { minLength: 1, maxLength: 200 },
          before: { minimum: 0, maximum: 20, default: 3 },
          after: { minimum: 0, maximum: 20, default: 3 },
        },
      });
    });

    it('reads context around a hit, and reports an unknown item as a tool error', async () => {
      const found = await call(HOST_READ_CHAT_CONTEXT_TOOL, {
        runId: RUN,
        itemId: 'm1',
      });
      expect(found.isError).toBe(false);
      expect(JSON.parse(found.content[0]!.text.split('\n')[1]!)).toMatchObject({
        runId: RUN,
        items: [{ itemId: 'm1', target: true }],
      });

      const missing = await call(HOST_READ_CHAT_CONTEXT_TOOL, {
        runId: RUN,
        itemId: 'nope',
      });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]!.text).toContain(
        `${HOST_READ_CHAT_CONTEXT_TOOL} failed`,
      );
    });
  });

  it('tools/call ask_user_question returns the user’s own answer as plain text', async () => {
    const questions = new UserQuestionBroker();
    const asked: string[] = [];
    questions.register('run-1', 'agent', async (qs, title) => {
      asked.push(`${title ?? '-'}:${qs[0]?.question ?? ''}`);
      return { status: 'answered', answer: 'Postgres' };
    });
    const { json } = await post(
      service(new CallBroker(), questions),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_QUESTION_TOOL,
        arguments: {
          title: 'Storage',
          questions: [
            { question: 'Which database?', options: [{ label: 'Postgres' }] },
          ],
        },
      }),
    );
    const result = json().result as {
      content: { type: string; text: string }[];
      isError: boolean;
    };
    expect(asked).toEqual(['Storage:Which database?']);
    expect(result.content[0]!.text).toContain('Postgres');
    // A question the user ANSWERED is not a tool failure, and neither are the
    // other two outcomes — see the dispatch's own note.
    expect(result.isError).toBe(false);
  });

  it('bounds the card’s TITLE before it reaches the asker', async () => {
    // The title went through raw while every other field of the call was
    // read — and it is written onto the card, the row and the run.
    const questions = new UserQuestionBroker();
    const titles: (string | null)[] = [];
    questions.register('run-1', 'agent', async (_qs, title) => {
      titles.push(title);
      return { status: 'answered', answer: 'ok' };
    });
    await post(
      service(new CallBroker(), questions),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_QUESTION_TOOL,
        arguments: {
          title: 't'.repeat(MAX_HOST_QUESTION_TITLE_LENGTH * 10),
          questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
        },
      }),
    );
    expect(titles).toEqual(['t'.repeat(MAX_HOST_QUESTION_TITLE_LENGTH)]);
  });

  it('routes notifications/cancelled to the parked call it names', async () => {
    // The whole reason this needs a map on the SERVICE: the notification comes
    // in as its own POST, so the SDK's built-in handler runs on a fresh
    // `Server` whose in-flight map is empty and aborts nothing. Measured on
    // cursor-agent — a `tools/call` parked for 60s is followed by exactly this
    // second POST, and the card it belonged to stayed on screen.
    const questions = new UserQuestionBroker();
    let parked!: (outcome: { status: 'unavailable'; reason: string }) => void;
    const asking = new Promise<AbortSignal | undefined>((ready) => {
      questions.register('run-1', 'agent', async (_qs, _title, signal) => {
        ready(signal);
        return await new Promise((resolve) => {
          parked = resolve;
          signal?.addEventListener('abort', () => {
            resolve({ status: 'unavailable', reason: 'the agent gave up' });
          });
        });
      });
    });
    const http = await serving(service(new CallBroker(), questions));
    try {
      const call = http.send(
        rpc(
          'tools/call',
          {
            name: HOST_QUESTION_TOOL,
            arguments: {
              questions: [
                { question: 'How deep?', options: [{ label: 'Standard' }] },
              ],
            },
          },
          7,
        ),
      );
      const signal = await asking;
      expect(signal?.aborted).toBe(false);

      const ack = await http.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 7, reason: 'timed out' },
      });
      // A notification-only POST is acknowledged and answers no body.
      expect(ack.status).toBe(202);
      expect(signal?.aborted).toBe(true);

      const result = (
        (await (await call).json()) as {
          result: { content: { text: string }[] };
        }
      ).result;
      expect(result.content[0]!.text).toContain('the agent gave up');
    } finally {
      parked({ status: 'unavailable', reason: 'test over' });
      http.close();
    }
  });

  it('leaves a parked call alone when the cancellation names another request', async () => {
    // The id is what makes a cancellation actionable: one endpoint routinely
    // holds several parked cards, so cancelling on anything looser would close
    // cards the agent is still waiting on.
    const questions = new UserQuestionBroker();
    let parked!: (outcome: { status: 'unavailable'; reason: string }) => void;
    const asking = new Promise<AbortSignal | undefined>((ready) => {
      questions.register('run-1', 'agent', async (_qs, _title, signal) => {
        ready(signal);
        return await new Promise((resolve) => {
          parked = resolve;
        });
      });
    });
    const http = await serving(service(new CallBroker(), questions));
    try {
      void http.send(
        rpc(
          'tools/call',
          {
            name: HOST_QUESTION_TOOL,
            arguments: {
              questions: [
                { question: 'How deep?', options: [{ label: 'Standard' }] },
              ],
            },
          },
          7,
        ),
      );
      const signal = await asking;

      await http.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 8, reason: 'a different call' },
      });

      expect(signal?.aborted).toBe(false);
    } finally {
      parked({ status: 'unavailable', reason: 'test over' });
      http.close();
    }
  });

  it('refuses a call whose questions cannot be read, without asking anybody', async () => {
    const questions = new UserQuestionBroker();
    let asks = 0;
    questions.register('run-1', 'agent', async () => {
      asks += 1;
      return { status: 'declined' };
    });
    const { json } = await post(
      service(new CallBroker(), questions),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_QUESTION_TOOL,
        arguments: { questions: [{ question: 'Which?', options: [] }] },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(asks).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
  });

  it('tools/call call_agent returns the broker envelope as text content', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'find X', title: 'Find X' },
      }),
    );
    const result = json().result as {
      content: { type: string; text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'research done' },
    });
  });

  it("hands call_agent and await_agent the request's own abort signal, and lets await_agent omit call_id", async () => {
    // The only production route to a sync call noticing its client gave up:
    // without the signal, a dropped call's waiter swallows the next question.
    const callBroker = broker();
    const callSpy = vi.spyOn(callBroker, 'callAgent');
    const awaitSpy = vi.spyOn(callBroker, 'awaitAgent');
    await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'find X', title: 'Find X' },
      }),
    );
    expect(callSpy.mock.calls[0]![3]).toBeInstanceOf(AbortSignal);

    const { json } = await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', { name: 'await_agent', arguments: {} }),
    );
    // An omitted window reaches the broker as the DEFAULT one, never as
    // unbounded: an unbounded wait outlives the caller's HTTP client, which
    // answers the model `The operation timed out.` instead of `pending`.
    expect(awaitSpy.mock.calls[0]![2]).toEqual({
      call_id: undefined,
      timeout_ms: DEFAULT_AWAIT_TIMEOUT_MS,
    });
    expect(awaitSpy.mock.calls[0]![3]).toBeInstanceOf(AbortSignal);
    const text = (json().result as { content: { text: string }[] }).content[0]!
      .text;
    expect(text).not.toContain('INVALID_ARGS');
  });

  it('calls as the CONVERSATION a callee turn answers in, named by its route', async () => {
    // Two calls to one node are two processes, each handed its own route; the
    // broker keys ownership by what arrives here, so a route that dropped the
    // conversation would make every conversation of the node one caller again.
    const callBroker = broker();
    const callSpy = vi.spyOn(callBroker, 'callAgent');
    const awaitSpy = vi.spyOn(callBroker, 'awaitAgent');
    await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'find X', title: 'Find X' },
      }),
      'call-7',
    );
    expect(callSpy.mock.calls[0]![1]).toBe(callerKey('orch', 'call-7'));
    await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', { name: 'await_agent', arguments: {} }),
    );
    // The node's own route is its own conversation — the bare node id.
    expect(awaitSpy.mock.calls[0]![1]).toBe('orch');
  });

  it('releases a waiting await_agent when the CLIENT cancels it, though the socket stays open', async () => {
    // cursor-agent's shape: at its 60s deadline it sends
    // `notifications/cancelled` and keeps the POST open, so a wait keyed on the
    // socket alone went on as a waiter nobody reads — and took the next
    // question another call parked. The collection comes back abandoned, with
    // nothing consumed.
    const capability: RunCallCapability = {
      calleesOf: new Map([['agent', [HELPER]]]),
      // Never settles on its own: the callee is still working.
      launchCalleeTurn: () => new Promise(() => {}),
      persistItem: () => {},
      isCancelled: () => false,
      isSuperseded: () => false,
      toolCallDeadlineMs: () => null,
      cancelCalleeTurn: () => false,
      messageCallee: () => ({ delivered: false, reason: 'not_started' }),
      isNodeLive: () => true,
      tellLiveNode: () => false,
      wakeNode: () => false,
    };
    const callBroker = new CallBroker();
    callBroker.registerRun('run-1', capability);
    const awaitSpy = vi.spyOn(callBroker, 'awaitAgent');
    const http = await serving(service(callBroker));
    try {
      const started = await http.send(
        rpc('tools/call', {
          name: 'call_agent',
          arguments: {
            agent: 'helper',
            message: 'research',
            title: 'Research',
            mode: 'async',
          },
        }),
      );
      expect(await started.text()).toContain('call-1');

      const waiting = http.send(
        rpc(
          'tools/call',
          {
            name: 'await_agent',
            arguments: { call_id: 'call-1', timeout_ms: 200_000 },
          },
          9,
        ),
      );
      await vi.waitFor(() => expect(awaitSpy).toHaveBeenCalled());
      await http.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 9, reason: 'timed out' },
      });

      const answered = await Promise.race([
        waiting.then(async (res) => res.text()),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('STILL WAITING'), 3_000).unref();
        }),
      ]);
      expect(answered).toContain('AWAIT_ABANDONED');
    } finally {
      http.close();
    }
  });

  it('tells a caller the wait window its OWN CLI allows, not the widest one', async () => {
    // A cursor caller's client gives up at 60s, so promising it 240s would
    // have it wait past its own deadline expecting an answer that never comes.
    const capability: RunCallCapability = {
      calleesOf: new Map([['orch', [HELPER]]]),
      launchCalleeTurn: () => new Promise(() => {}),
      persistItem: () => {},
      isCancelled: () => false,
      isSuperseded: () => false,
      toolCallDeadlineMs: () => 60_000,
      cancelCalleeTurn: () => false,
      messageCallee: () => ({ delivered: false, reason: 'not_started' }),
      isNodeLive: () => true,
      tellLiveNode: () => false,
      wakeNode: () => false,
    };
    const callBroker = new CallBroker();
    callBroker.registerRun('run-1', capability);
    const { json } = await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const timeout = (
      json().result as {
        tools: {
          name: string;
          inputSchema: {
            properties: Record<
              string,
              { maximum?: number; description?: string }
            >;
          };
        }[];
      }
    ).tools.find((tool) => tool.name === 'await_agent')!.inputSchema.properties
      .timeout_ms!;
    expect(timeout.maximum).toBe(48_000);
    expect(timeout.description).toContain('Omitted, it is 48000ms');
  });

  it('refuses call_agent with a missing, empty, or whitespace-only title', async () => {
    for (const args of [
      { agent: 'helper', message: 'm' },
      { agent: 'helper', message: 'm', title: '' },
      { agent: 'helper', message: 'm', title: '   ' },
    ]) {
      const { json } = await post(
        service(),
        'run-1',
        'orch',
        rpc('tools/call', { name: 'call_agent', arguments: args }),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('INVALID_ARGS');
      expect(result.content[0]!.text).toContain('title');
    }
  });

  it('refuses a call_agent title carrying a control or text-direction character', async () => {
    for (const title of ['look\u0000up', 'why \u202Esi siht']) {
      const { json } = await post(
        service(),
        'run-1',
        'orch',
        rpc('tools/call', {
          name: 'call_agent',
          arguments: { agent: 'helper', message: 'm', title },
        }),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('INVALID_ARGS');
      expect(result.content[0]!.text).toContain('title');
    }
  });

  it('refuses a call_agent title over the length bound', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'm', title: 'x'.repeat(201) },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
    expect(result.content[0]!.text).toContain('title');
  });

  it('accepts a call_agent title at exactly the bound, measured after trimming', async () => {
    for (const title of ['x'.repeat(200), `  ${'x'.repeat(200)}  `]) {
      const { json } = await post(
        service(),
        'run-1',
        'orch',
        rpc('tools/call', {
          name: 'call_agent',
          arguments: { agent: 'helper', message: 'm', title },
        }),
      );
      const result = json().result as { content: { text: string }[] };
      expect(result.content[0]!.text).not.toContain('INVALID_ARGS');
    }
  });

  it('trims a valid call_agent title before it reaches the broker', async () => {
    const persisted: { kind: string; payload: Record<string, unknown> }[] = [];
    const capability: RunCallCapability = {
      calleesOf: new Map([['orch', [HELPER]]]),
      launchCalleeTurn: async () => ({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: null,
      }),
      persistItem: (_nodeId, kind, _role, payload) => {
        persisted.push({ kind, payload: payload as Record<string, unknown> });
      },
      isCancelled: () => false,
      isSuperseded: () => false,
      toolCallDeadlineMs: () => null,
      cancelCalleeTurn: () => false,
      messageCallee: () => ({ delivered: false, reason: 'not_started' }),
      isNodeLive: () => true,
      tellLiveNode: () => false,
      wakeNode: () => false,
    };
    const instance = new CallBroker();
    instance.registerRun('run-1', capability);

    await post(
      service(instance),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: {
          agent: 'helper',
          message: 'm',
          title: '  Get concrete UAT links from the DB  ',
        },
      }),
    );

    const started = persisted.find((p) => p.kind === 'call_started');
    expect(started?.payload.title).toBe('Get concrete UAT links from the DB');
  });

  it('bad arguments and unknown tools come back as error ENVELOPES, never bare throws', async () => {
    const target = service();
    const badArgs = await post(
      target,
      'run-1',
      'orch',
      rpc('tools/call', { name: 'call_agent', arguments: { agent: 'helper' } }),
    );
    const badArgsResult = badArgs.json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(badArgsResult.isError).toBe(true);
    expect(JSON.parse(badArgsResult.content[0]!.text).error).toContain(
      'INVALID_ARGS',
    );

    const unknown = await post(
      target,
      'run-1',
      'orch',
      rpc('tools/call', { name: 'launch_missiles', arguments: {} }),
    );
    const unknownResult = unknown.json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(unknownResult.isError).toBe(true);
    expect(JSON.parse(unknownResult.content[0]!.text).error).toContain(
      'UNKNOWN_TOOL',
    );
  });

  it('answers a dead run with the RUN_NOT_ACTIVE envelope', async () => {
    const { json } = await post(
      service(new CallBroker()),
      'run-9',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'm', title: 't' },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toContain(
      'RUN_NOT_ACTIVE',
    );
  });

  it('maps an escaped exception to an in-protocol JSON-RPC error (never the Nest filter shape)', async () => {
    // A missing raw request throws inside the transport conversion — the
    // catch-all must answer JSON-RPC, because the global ExceptionsFilter's
    // {statusCode, code, …} body is unparseable to an MCP client.
    class FakeRes extends EventEmitter {
      statusCode = 0;
      headersSent = false;
      writableEnded = false;
      body = '';
      writeHead(status: number): this {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      }
      end(chunk?: unknown): this {
        if (chunk !== undefined) {
          this.body += String(chunk);
        }
        this.writableEnded = true;
        return this;
      }
    }
    const res = new FakeRes();
    const req = {
      raw: undefined,
      body: rpc('tools/list', {}),
      headers: {},
    } as unknown as FastifyRequest;
    const reply = { raw: res, hijack: () => {} } as unknown as FastifyReply;
    await service().handlePost('run-1', 'orch', req, reply);
    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.error).toBeDefined();
    expect(parsed).not.toHaveProperty('statusCode');
  });

  it('a parked question is a NON-error question envelope; answer_agent settles it over the endpoint (M4)', async () => {
    const instance = new CallBroker();
    const capability: RunCallCapability = {
      calleesOf: new Map([['orch', [HELPER]]]),
      launchCalleeTurn: (_callee, _message, callId) => {
        setTimeout(() => {
          instance.parkQuestion('run-1', callId, {
            question: 'Which color?',
            options: ['Red', 'Blue'],
            payload: null,
            deliver: () => true,
            fail: () => {},
          });
        }, 0);
        // Parked "forever" — the test consumes only the question leg.
        return new Promise(() => {});
      },
      persistItem: () => {},
      isCancelled: () => false,
      isSuperseded: () => false,
      toolCallDeadlineMs: () => null,
      cancelCalleeTurn: () => false,
      messageCallee: () => ({ delivered: false, reason: 'not_started' }),
      isNodeLive: () => true,
      tellLiveNode: () => false,
      wakeNode: () => false,
    };
    instance.registerRun('run-1', capability);
    const target = service(instance);

    const asked = await post(
      target,
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'm', title: 't' },
      }),
    );
    const askedResult = asked.json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(askedResult.isError).toBe(false);
    expect(JSON.parse(askedResult.content[0]!.text)).toEqual({
      status: 'question',
      call_id: 'call-1',
      agent: 'helper',
      question: 'Which color?',
      options: ['Red', 'Blue'],
    });

    // Ownership is enforced across the endpoint: another node may not answer.
    const stolen = await post(
      target,
      'run-1',
      'intruder',
      rpc('tools/call', {
        name: 'answer_agent',
        arguments: { call_id: 'call-1', answer: 'Blue' },
      }),
    );
    const stolenResult = stolen.json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(stolenResult.isError).toBe(true);
    expect(JSON.parse(stolenResult.content[0]!.text).error).toContain(
      'UNKNOWN_CALL',
    );

    const answered = await post(
      target,
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'answer_agent',
        arguments: { call_id: 'call-1', answer: 'Blue' },
      }),
    );
    const answeredResult = answered.json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(answeredResult.isError).toBe(false);
    expect(JSON.parse(answeredResult.content[0]!.text)).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', state: 'answered' },
    });

    // Empty answers are refused at the endpoint, in-envelope.
    const empty = await post(
      target,
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'answer_agent',
        arguments: { call_id: 'call-1', answer: '   ' },
      }),
    );
    expect(
      JSON.parse(
        (empty.json().result as { content: { text: string }[] }).content[0]!
          .text,
      ).error,
    ).toContain('INVALID_ARGS');
  });

  it('refuses an oversize answer in-envelope (single stdin control line cap)', async () => {
    const { json } = await post(
      service(new CallBroker()),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'answer_agent',
        arguments: { call_id: 'call-1', answer: 'x'.repeat(40_000) },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toContain('INVALID_ARGS');
  });

  it('does not offer report_findings to a node with nowhere to draw a card', async () => {
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain(HOST_FINDINGS_TOOL);
  });

  it('offers report_findings once a turn has registered a reporter', async () => {
    const findings = new FindingsReportBroker();
    findings.register('run-1', 'agent', async () => ({
      status: 'recorded',
      count: 0,
    }));
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker(), findings),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: { name: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    const tool = tools.find((t) => t.name === HOST_FINDINGS_TOOL);
    expect(tool).toBeDefined();
    // The advertised shape is claude's ReportFindings, snake_case included, so
    // an agent that has learned that tool needs to learn nothing new here.
    const items = (
      tool!.inputSchema as {
        properties: { findings: { items: { required: string[] } } };
      }
    ).properties.findings.items;
    expect(items.required).toEqual(['file', 'summary', 'failure_scenario']);
  });

  it('tools/call report_findings hands the report over and answers with a receipt', async () => {
    const findings = new FindingsReportBroker();
    const recorded: unknown[] = [];
    findings.register('run-1', 'agent', async (report) => {
      recorded.push(report);
      return { status: 'recorded', count: report.findings.length };
    });
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker(), findings),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_FINDINGS_TOOL,
        arguments: {
          level: 'high',
          findings: [
            {
              file: 'src/queue/processor.ts',
              line: 402,
              summary: 'finalizeCompleted no longer checks generation',
              short_summary: 'CAS guard weakened',
              failure_scenario: 'A superseded worker wins the write.',
              verdict: 'CONFIRMED',
            },
          ],
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(recorded).toEqual([
      {
        level: 'high',
        findings: [
          {
            file: 'src/queue/processor.ts',
            line: 402,
            summary: 'finalizeCompleted no longer checks generation',
            shortSummary: 'CAS guard weakened',
            failureScenario: 'A superseded worker wins the write.',
            verdict: 'CONFIRMED',
          },
        ],
      },
    ]);
    expect(result.isError).toBe(false);
    // A RECEIPT, never the findings themselves — the card is how the user sees
    // them, and echoing them here would spend the window on them twice.
    expect(result.content[0]!.text).toBe(
      '1 finding recorded and shown to the user.',
    );
    expect(result.content[0]!.text).not.toContain('finalizeCompleted');
  });

  it('accepts an empty report — nothing survived verification is an answer', async () => {
    const findings = new FindingsReportBroker();
    findings.register('run-1', 'agent', async (report) => ({
      status: 'recorded',
      count: report.findings.length,
    }));
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker(), findings),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_FINDINGS_TOOL,
        arguments: { findings: [] },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe('No findings recorded.');
  });

  it('refuses a findings argument that is not an array', async () => {
    const findings = new FindingsReportBroker();
    let reports = 0;
    findings.register('run-1', 'agent', async () => {
      reports += 1;
      return { status: 'recorded', count: 0 };
    });
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker(), findings),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_FINDINGS_TOOL,
        arguments: { findings: 'three things' },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
    expect(reports).toBe(0);
  });

  it('tells a call whose findings all failed to parse apart from an empty report', async () => {
    // Answering "0 findings recorded" here would have the model believe it had
    // reported and move on, when every finding it found was dropped at the edge.
    const findings = new FindingsReportBroker();
    let reports = 0;
    findings.register('run-1', 'agent', async () => {
      reports += 1;
      return { status: 'recorded', count: 0 };
    });
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker(), findings),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_FINDINGS_TOOL,
        arguments: { findings: [{ summary: 'a defect with no file' }] },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
    expect(reports).toBe(0);
  });

  it('answers a report it cannot record without flagging a tool failure', async () => {
    // The listing and the call are separate requests, so a turn can settle
    // between them. The agent still holds the findings and can write them out.
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_FINDINGS_TOOL,
        arguments: {
          findings: [
            {
              file: 'a.ts',
              summary: 'x',
              failure_scenario: 'y',
            },
          ],
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('could not be recorded');
    expect(result.content[0]!.text).toContain('in your reply');
  });

  it('does not offer show_chart to a node with nowhere to draw one', async () => {
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain(HOST_CHART_TOOL);
  });

  it('offers show_chart once a turn has registered a drawer', async () => {
    const charts = new ChartBroker();
    charts.register('run-1', 'agent', async () => ({
      status: 'drawn',
      series: 1,
      points: 1,
    }));
    const { json } = await post(
      service(
        new CallBroker(),
        new UserQuestionBroker(),
        new FindingsReportBroker(),
        charts,
      ),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: { name: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    const tool = tools.find((t) => t.name === HOST_CHART_TOOL);
    expect(tool).toBeDefined();
    // The kinds the card can actually draw, and no more: an enum the model can
    // read is what keeps `kind` from arriving as "sunburst".
    const kind = (
      tool!.inputSchema as { properties: { kind: { enum: string[] } } }
    ).properties.kind;
    expect(kind.enum).toEqual(['line', 'bar', 'area']);
  });

  it('tools/call publish_action hands the button and its calling conversation over and answers with its receipt', async () => {
    const actions = new ActionBroker();
    const published: unknown[] = [];
    const callers: string[] = [];
    actions.register('run-1', 'agent', {
      publish: async (input, caller) => {
        published.push(input);
        callers.push(caller);
        return { status: 'published', text: 'Published action "pr-merged".' };
      },
      remove: async () => ({ status: 'refused', reason: 'unused' }),
    });
    const call = async (args: Record<string, unknown>) => {
      const { json } = await post(
        actionService(actions),
        'run-1',
        'agent',
        rpc('tools/call', { name: HOST_PUBLISH_ACTION_TOOL, arguments: args }),
        'call-3',
      );
      return json().result as { content: { text: string }[]; isError: boolean };
    };

    const result = await call({
      label: 'PR merged',
      message: 'PR merged — continue',
      action_id: null,
    });

    expect(published).toEqual([
      { label: 'PR merged', message: 'PR merged — continue' },
    ]);
    // The sink, not the model, learns which conversation published it.
    expect(callers).toEqual([callerKey('agent', 'call-3')]);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Published action "pr-merged".' }],
      isError: false,
    });
    // A misspelt kind must not publish a button that sends nothing.
    expect(await call({ label: 'x', mesage: 'typo' })).toMatchObject({
      isError: true,
    });
    expect(published).toHaveLength(1);
  });

  it('tools/call answers a refused publish as an error, and remove_action with its receipt', async () => {
    const actions = new ActionBroker();
    const removed: string[] = [];
    actions.register('run-1', 'agent', {
      publish: async () => ({
        status: 'refused',
        reason: 'give exactly one of message, stop or command',
      }),
      remove: async (actionId, caller) => {
        removed.push(`${actionId} by ${caller}`);
        return { status: 'removed', text: `Removed action "${actionId}".` };
      },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const { json } = await post(
        actionService(actions),
        'run-1',
        'agent',
        rpc('tools/call', { name, arguments: args }),
      );
      return json().result as { content: { text: string }[]; isError: boolean };
    };

    expect(await call(HOST_PUBLISH_ACTION_TOOL, { label: 'x' })).toEqual({
      content: [
        {
          type: 'text',
          text: 'INVALID_ARGS: give exactly one of message, stop or command',
        },
      ],
      isError: true,
    });
    expect(
      await call(HOST_REMOVE_ACTION_TOOL, { action_id: 'pr-merged' }),
    ).toEqual({
      content: [{ type: 'text', text: 'Removed action "pr-merged".' }],
      isError: false,
    });
    expect(removed).toEqual(['pr-merged by agent']);
  });

  it('tools/call show_chart hands the chart over and answers with a receipt', async () => {
    const charts = new ChartBroker();
    const drawn: unknown[] = [];
    charts.register('run-1', 'agent', async (chart) => {
      drawn.push(chart);
      return {
        status: 'drawn',
        series: chart.series.length,
        points: chart.labels.length,
      };
    });
    const { json } = await post(
      service(
        new CallBroker(),
        new UserQuestionBroker(),
        new FindingsReportBroker(),
        charts,
      ),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_CHART_TOOL,
        arguments: {
          title: 'Test suite duration',
          kind: 'line',
          y_label: 'seconds',
          labels: ['a1b2', 'c3d4'],
          series: [{ name: 'unit', values: [12.1, 13.4] }],
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(drawn).toEqual([
      {
        title: 'Test suite duration',
        kind: 'line',
        yLabel: 'seconds',
        labels: ['a1b2', 'c3d4'],
        series: [{ name: 'unit', values: [12.1, 13.4] }],
      },
    ]);
    expect(result.isError).toBe(false);
    // A RECEIPT, never the numbers — same bargain as the findings tool.
    expect(result.content[0]!.text).toBe(
      'Chart drawn for the user: 1 series over 2 points.',
    );
    expect(result.content[0]!.text).not.toContain('12.1');
  });

  it('refuses a chart with nothing plottable, without reaching the drawer', async () => {
    // Unlike an empty findings report — a real review outcome — a chart of
    // nothing is only ever a mistake, so it is answered as a malformed call.
    const charts = new ChartBroker();
    const drawn: unknown[] = [];
    charts.register('run-1', 'agent', async (chart) => {
      drawn.push(chart);
      return { status: 'drawn', series: 0, points: 0 };
    });
    const { json } = await post(
      service(
        new CallBroker(),
        new UserQuestionBroker(),
        new FindingsReportBroker(),
        charts,
      ),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_CHART_TOOL,
        arguments: { title: 'Nothing', kind: 'bar', labels: [], series: [] },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
    expect(drawn).toEqual([]);
  });

  it('does not offer show_gallery to a node with nowhere to show one', async () => {
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain(HOST_GALLERY_TOOL);
  });

  it('tools/call show_gallery hands the set over and answers with a receipt', async () => {
    const galleries = new GalleryBroker();
    const shown: unknown[] = [];
    galleries.register('run-1', 'agent', async (gallery) => {
      shown.push(gallery);
      return { status: 'drawn', images: gallery.images.length };
    });
    const { json } = await post(
      galleryService(galleries),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_GALLERY_TOOL,
        arguments: {
          title: 'Before and after',
          images: [
            { path: '/tmp/before.png', caption: 'the old header' },
            'after.png',
          ],
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(shown).toEqual([
      {
        title: 'Before and after',
        images: [
          { path: '/tmp/before.png', caption: 'the old header' },
          { path: 'after.png' },
        ],
      },
    ]);
    expect(result.isError).toBe(false);
    // A RECEIPT, never the paths — same bargain as its siblings.
    expect(result.content[0]!.text).toBe(
      'Gallery shown to the user: 2 images.',
    );
    expect(result.content[0]!.text).not.toContain('.png');
  });

  it('does not offer show_artifact to a node with nowhere to publish one', async () => {
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain(HOST_ARTIFACT_TOOL);
  });

  it('tools/call show_artifact hands the page over and answers with a receipt', async () => {
    const artifacts = new ArtifactBroker();
    const published: unknown[] = [];
    artifacts.register('run-1', 'agent', async (artifact) => {
      published.push(artifact);
      return { status: 'published', artifactId: 'migration-plan', version: 1 };
    });
    const { json } = await post(
      artifactService(artifacts),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_ARTIFACT_TOOL,
        arguments: {
          title: 'Migration plan',
          artifact_id: 'Migration Plan',
          html: '<!doctype html><title>Plan</title><p>step one',
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(published).toEqual([
      {
        title: 'Migration plan',
        id: 'migration-plan',
        html: '<!doctype html><title>Plan</title><p>step one',
      },
    ]);
    expect(result.isError).toBe(false);
    // A RECEIPT, never the document — same bargain as its siblings, and the
    // one thing it must add is the id the agent revises with.
    expect(result.content[0]!.text).toContain('migration-plan');
    expect(result.content[0]!.text).not.toContain('<');
  });

  it('tools/call show_artifact names the publishing CONVERSATION, so a callee’s page is filed under its call', async () => {
    const artifacts = new ArtifactBroker();
    const callers: string[] = [];
    artifacts.register('run-1', 'agent', async (_artifact, caller) => {
      callers.push(caller);
      return { status: 'published', artifactId: 'plan', version: 1 };
    });
    const call = rpc('tools/call', {
      name: HOST_ARTIFACT_TOOL,
      arguments: {
        title: 'Plan',
        html: '<!doctype html><title>Plan</title><p>step one',
      },
    });
    await post(artifactService(artifacts), 'run-1', 'agent', call, 'call-3');
    await post(artifactService(artifacts), 'run-1', 'agent', call);
    expect(callers).toEqual([callerKey('agent', 'call-3'), 'agent']);
  });

  it('tells a WORKFLOW agent its page reaches the user whoever publishes it, and a chat nothing of the kind', async () => {
    const description = async (inWorkflow: boolean): Promise<string> => {
      const artifacts = new ArtifactBroker();
      artifacts.register('run-1', 'agent', async () => ({
        status: 'published',
        artifactId: 'x',
        version: 1,
      }));
      if (inWorkflow) {
        // What the executor does for every workflow run, call edges or none.
        artifacts.markWorkflowRun('run-1');
      }
      const { json } = await post(
        artifactService(artifacts),
        'run-1',
        'agent',
        rpc('tools/list', {}),
      );
      return (
        json().result as { tools: { name: string; description: string }[] }
      ).tools.find((t) => t.name === HOST_ARTIFACT_TOOL)!.description;
    };
    const workflow = await description(true);
    expect(workflow).toContain('WHICHEVER agent of the run publishes it');
    expect(workflow).toContain('never hand the HTML to your caller');
    expect(workflow).toContain('Ids belong to the whole run');
    const chat = await description(false);
    expect(chat).not.toContain('WHICHEVER agent');
    expect(chat).not.toContain('Ids belong to the whole run');
  });

  it('tells a caller, in call_agent AND await_agent, that its result names the pages the callee published', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as { tools: { name: string; description: string }[] }
    ).tools;
    for (const name of ['call_agent', 'await_agent']) {
      const text = tools.find((t) => t.name === name)!.description;
      expect(text).toContain('"artifacts"');
      expect(text).toContain('never publish them again');
    }
  });

  describe('show_artifact share', () => {
    const publishing = (): ArtifactBroker => {
      const artifacts = new ArtifactBroker();
      artifacts.register('run-1', 'agent', async () => ({
        status: 'published',
        artifactId: 'report',
        version: 2,
      }));
      return artifacts;
    };
    const shareCall = (share: unknown) =>
      rpc('tools/call', {
        name: HOST_ARTIFACT_TOOL,
        arguments: { title: 'Report', html: '<p>x', share },
      });
    const listing = async (agentsMayShare: boolean) => {
      const { json } = await post(
        artifactService(publishing(), fakeShares(agentsMayShare).service),
        'run-1',
        'agent',
        rpc('tools/list', {}),
      );
      return (
        json().result as {
          tools: {
            name: string;
            description: string;
            inputSchema: { properties: Record<string, unknown> };
          }[];
        }
      ).tools.find((t) => t.name === HOST_ARTIFACT_TOOL)!;
    };

    it('offers the share switch only while the user lets agents share', async () => {
      const off = await listing(false);
      expect(off.inputSchema.properties).not.toHaveProperty('share');
      expect(off.description).not.toContain('SHARING');
      const on = await listing(true);
      expect(on.inputSchema.properties).toHaveProperty('share');
      expect(on.description).toContain('Shared link: <url>');
    });

    it('shares after publishing and hands the agent the link', async () => {
      const shares = fakeShares(true);
      const { json } = await post(
        artifactService(publishing(), shares.service),
        'run-1',
        'agent',
        shareCall(true),
      );
      const text = (json().result as { content: { text: string }[] })
        .content[0]!.text;
      expect(shares.asked).toEqual([
        { artifactId: 'report', title: 'Report', remote: false },
      ]);
      expect(text).toContain(
        'Shared link: https://pages.example.com/x/index.html#k=KEY',
      );
    });

    it('tells the share a call came through the gateway from a paired device', async () => {
      const shares = fakeShares(true);
      await post(
        artifactService(publishing(), shares.service),
        'run-1',
        'agent',
        shareCall(true),
        null,
        { 'x-geniro-via': 'remote' },
      );
      expect(shares.asked).toEqual([
        { artifactId: 'report', title: 'Report', remote: true },
      ]);
    });

    it('answers a refused share as a reason on a successful publish, never an error', async () => {
      const shares = fakeShares(true, {
        kind: 'not-shared',
        reason: 'the upload failed',
      });
      const { json } = await post(
        artifactService(publishing(), shares.service),
        'run-1',
        'agent',
        shareCall(true),
      );
      const result = json().result as {
        content: { text: string }[];
        isError: boolean;
      };
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toContain('updated to version 2');
      expect(result.content[0]!.text).toContain(
        'Not shared: the upload failed.',
      );
    });

    it('shares nothing when the publish itself was refused', async () => {
      const shares = fakeShares(true);
      const artifacts = new ArtifactBroker();
      artifacts.register('run-1', 'agent', async () => ({
        status: 'rejected',
        reason: 'over the limit',
      }));
      await post(
        artifactService(artifacts, shares.service),
        'run-1',
        'agent',
        shareCall(true),
      );
      expect(shares.asked).toEqual([]);
    });

    it('shares nothing unless the call asks', async () => {
      const shares = fakeShares(true);
      await post(
        artifactService(publishing(), shares.service),
        'run-1',
        'agent',
        shareCall(false),
      );
      expect(shares.asked).toEqual([]);
    });
  });

  it('refuses a show_artifact call carrying no document, without reaching the run', async () => {
    const artifacts = new ArtifactBroker();
    const published: unknown[] = [];
    artifacts.register('run-1', 'agent', async (artifact) => {
      published.push(artifact);
      return { status: 'published', artifactId: 'x', version: 1 };
    });
    const { json } = await post(
      artifactService(artifacts),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_ARTIFACT_TOOL,
        arguments: { title: 'A page with nothing in it' },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
    expect(published).toEqual([]);
  });

  it('answers a REFUSED page as an outcome rather than a failed call', async () => {
    // An oversize page is something the agent acts on by writing a smaller
    // one, so `isError` stays false — an error would read to the model as its
    // own call being malformed.
    const artifacts = new ArtifactBroker();
    artifacts.register('run-1', 'agent', async () => ({
      status: 'rejected',
      reason: 'the page is 900KB, over the 512KB limit — publish a smaller one',
    }));
    const { json } = await post(
      artifactService(artifacts),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_ARTIFACT_TOOL,
        arguments: { title: 'Huge', html: '<p>x' },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('512KB limit');
  });

  it('tools/call notify_user hands the message to the run and answers with a receipt', async () => {
    const notices = new NotifyBroker();
    const sent: string[] = [];
    notices.register('run-1', 'agent', async (message) => {
      sent.push(message);
      return { status: 'sent' };
    });
    const { json } = await post(
      service(
        new CallBroker(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        notices,
      ),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_NOTIFY_TOOL,
        arguments: { message: '  The dev server is running at :3000.  ' },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(sent).toEqual(['The dev server is running at :3000.']);
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('Notification sent');
  });

  it('refuses a notify_user call with no message, without reaching the run', async () => {
    // A banner with nothing in it is only ever a mistake.
    const notices = new NotifyBroker();
    const sent: string[] = [];
    notices.register('run-1', 'agent', async (message) => {
      sent.push(message);
      return { status: 'sent' };
    });
    const { json } = await post(
      service(
        new CallBroker(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        notices,
      ),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_NOTIFY_TOOL,
        arguments: { message: '   ' },
      }),
    );
    const result = json().result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('refuses a gallery naming no picture, without reaching the drawer', async () => {
    // A gallery of nothing is only ever a mistake, so it is a malformed call
    // rather than an empty result — the chart's rule, not the findings tool's.
    const galleries = new GalleryBroker();
    const shown: unknown[] = [];
    galleries.register('run-1', 'agent', async (gallery) => {
      shown.push(gallery);
      return { status: 'drawn', images: 0 };
    });
    const { json } = await post(
      galleryService(galleries),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_GALLERY_TOOL,
        arguments: { images: [{ caption: 'no path here' }] },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGS');
    expect(shown).toEqual([]);
  });

  it('answers a gallery it cannot show without flagging a tool failure', async () => {
    // An unavailable channel is an ANSWER the agent carries on from, not a
    // failed call — it still knows where the files are.
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_GALLERY_TOOL,
        arguments: { images: ['late.png'] },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('could not be shown');
  });

  it('answers a chart it cannot draw without flagging a tool failure', async () => {
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_CHART_TOOL,
        arguments: {
          title: 'Late',
          kind: 'line',
          labels: ['a'],
          series: [{ name: 'unit', values: [1] }],
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('could not be drawn');
    expect(result.content[0]!.text).toContain('in your reply');
  });

  it('does not offer propose_patch to a node with nobody to accept it', async () => {
    const { json } = await post(
      service(new CallBroker(), new UserQuestionBroker()),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain(HOST_PATCH_TOOL);
  });

  it('offers propose_patch with Edit’s own field names', async () => {
    // Not cosmetic: the renderer's `editDiffOf` reads exactly these, so the
    // card draws the diff with no second diff renderer.
    const patches = new PatchBroker();
    patches.register('run-1', 'agent', async () => ({
      status: 'declined',
    }));
    const { json } = await post(
      patchService(patches),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: { name: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    const tool = tools.find((t) => t.name === HOST_PATCH_TOOL);
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'file_path',
      'new_string',
      'old_string',
      'summary',
    ]);
    // `old_string` is NOT required — omitting it is how a whole file is written.
    expect(schema.required).not.toContain('old_string');
  });

  it('tools/call propose_patch hands the patch over and answers the verdict', async () => {
    const patches = new PatchBroker();
    const seen: unknown[] = [];
    patches.register('run-1', 'agent', async (patch) => {
      seen.push(patch);
      return { status: 'applied', path: 'src/a.ts' };
    });
    const { json } = await post(
      patchService(patches),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_PATCH_TOOL,
        arguments: {
          file_path: 'src/a.ts',
          old_string: 'const timeout = 30;',
          new_string: 'const timeout = 60;',
          summary: 'Raise the timeout',
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(seen).toEqual([
      {
        filePath: 'src/a.ts',
        oldString: 'const timeout = 30;',
        newString: 'const timeout = 60;',
        summary: 'Raise the timeout',
      },
    ]);
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('Applied to src/a.ts');
    expect(result.content[0]!.text).toContain('do not write it again');
  });

  it('a REJECTION is not a tool error — the user used the gate', async () => {
    // Flagged as an error, a model reads its own call as malformed and retries
    // the change the user just turned down.
    const patches = new PatchBroker();
    patches.register('run-1', 'agent', async () => ({ status: 'declined' }));
    const { json } = await post(
      patchService(patches),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_PATCH_TOOL,
        arguments: { file_path: 'a.ts', new_string: 'x' },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('Do not apply it another way');
  });

  it('refuses a malformed patch by NAMING the field, without asking anybody', async () => {
    const patches = new PatchBroker();
    const seen: unknown[] = [];
    patches.register('run-1', 'agent', async (patch) => {
      seen.push(patch);
      return { status: 'declined' };
    });
    const { json } = await post(
      patchService(patches),
      'run-1',
      'agent',
      rpc('tools/call', {
        name: HOST_PATCH_TOOL,
        arguments: {
          file_path: 'a.ts',
          old_string: 'same',
          new_string: 'same',
        },
      }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('identical');
    expect(seen).toEqual([]);
  });

  it('methodNotAllowed answers 405 with a JSON-RPC error body', () => {
    const send = vi.fn();
    const header = vi.fn(() => ({ send }));
    const status = vi.fn(() => ({ header }));
    service().methodNotAllowed({ status } as unknown as FastifyReply);
    expect(status).toHaveBeenCalledWith(405);
    expect(header).toHaveBeenCalledWith('allow', 'POST');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ jsonrpc: '2.0' }),
    );
  });
});

/**
 * The tool DESCRIPTIONS, which are the routing logic — the only thing that
 * decides which of seven near-neighbours a model reaches for. They were written
 * one tool at a time and audited only later as a set, which is how `show_chart`
 * came to describe the scorecard case without ever naming `show_metrics`, and
 * how `propose_patch` came to promise "the four outcomes" and list three.
 *
 * Asserted on the tools/list RESPONSE rather than on the source string: that is
 * the text a model actually receives.
 */
describe('McpServerService — the board tools', () => {
  /** A service whose board is `handler`, answering every call it is handed. */
  const boardService = (handler: Partial<TaskBoardHandler> = {}) => {
    const board = new TaskBoardBroker();
    const call = vi.fn<TaskBoardHandler['call']>(async () => ({
      text: 'Created GEN-54 in backlog.',
      isError: false,
    }));
    board.install({ tools: () => BOARD_TOOLS, call, ...handler });
    const subject = service(
      new CallBroker(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      board,
    );
    return { subject, call };
  };

  const listed = async (subject: McpServerService) => {
    const { json } = await post(
      subject,
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    return (
      json().result as {
        tools: {
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
        }[];
      }
    ).tools;
  };

  const callTool = async (
    subject: McpServerService,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const { json } = await post(
      subject,
      'run-1',
      'agent',
      rpc('tools/call', { name, arguments: args }),
    );
    return json().result as {
      content: { text: string }[];
      isError?: boolean;
    };
  };

  it('offers every board tool to a run that works no card — a plain chat', async () => {
    // The fake board answers for run-1, which no card names: the listing does
    // not depend on whether the run works a card.
    const names = (await listed(boardService().subject)).map((t) => t.name);

    expect(names).toEqual(expect.arrayContaining([...HOST_BOARD_TOOLS]));
  });

  it('hands each board call to the board with the run and the arguments, and answers its words', async () => {
    const { subject, call } = boardService();

    const result = await callTool(subject, 'create_task', {
      project: 'GEN',
      title: 'Ship it',
    });

    expect(call).toHaveBeenCalledWith('run-1', 'create_task', {
      project: 'GEN',
      title: 'Ship it',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('Created GEN-54 in backlog.');
  });

  it('passes a board refusal through as a tool error', async () => {
    const { subject } = boardService({
      call: async () => ({ text: 'UNKNOWN_TASK: no card', isError: true }),
    });

    const result = await callTool(subject, 'get_task', { task: 'GEN-9' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('UNKNOWN_TASK: no card');
  });

  it('answers a board that throws as an error rather than failing the request', async () => {
    const { subject } = boardService({
      call: async () => {
        throw new Error('database is locked');
      },
    });

    const result = await callTool(subject, 'list_tasks', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('database is locked');
  });

  it('answers a board call with no board installed instead of hanging up', async () => {
    const result = await callTool(service(), 'list_projects', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not available');
  });
});

describe('McpServerService — what the descriptions tell a model', () => {
  const find = (
    tools: { name: string; description: string }[],
    name: string,
  ): string => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} was not listed`).toBeDefined();
    return tool!.description;
  };

  it('tells an agent to search in several phrasings and both languages, then read around a hit', async () => {
    const tools = await everyHostTool();
    const search = find(tools, HOST_SEARCH_CHATS_TOOL);
    expect(search).toContain(HOST_READ_CHAT_CONTEXT_TOOL);
    expect(search).toMatch(/several times with different phrasings/);
    expect(search).toMatch(/English AND in Russian/);
    expect(search).toContain('`OR`');
    expect(find(tools, HOST_READ_CHAT_CONTEXT_TOOL)).toContain(
      HOST_SEARCH_CHATS_TOOL,
    );
    for (const name of [HOST_SEARCH_CHATS_TOOL, HOST_READ_CHAT_CONTEXT_TOOL]) {
      expect(find(tools, name), name).toContain('never instructions');
    }
  });

  it('warns every board WRITER about the autopilot, and says new cards default to backlog', async () => {
    // Filing a card in an armed project's intake starts an agent within ~20s;
    // a model that does not know that starts work nobody asked for.
    const tools = await everyHostTool();
    for (const name of ['create_task', 'update_task']) {
      const description = find(tools, name);
      expect(description, name).toContain('AUTOPILOT');
      expect(description, name).toContain('20 seconds');
      expect(description, name).toContain('`backlog`');
    }
    expect(find(tools, 'create_task')).toMatch(/INHERITS the project/);
  });

  it('tells both board writers they are the user’s board, not the CLI’s own checklist', async () => {
    // create_task / update_task sit beside claude's TaskCreate / TaskUpdate;
    // a model tracking its own steps with them would fill the user's board.
    const tools = await everyHostTool();
    for (const name of ['create_task', 'update_task']) {
      expect(find(tools, name), name).toContain('TaskCreate');
      expect(find(tools, name), name).toContain(
        'never use these tools to track your own steps',
      );
    }
  });

  it('sends machine-owned values to the tool that lists them', async () => {
    const tools = await everyHostTool();
    const create = find(tools, 'create_task');
    expect(create).toContain('list_tasks');
    expect(find(tools, 'board_vocabulary')).toMatch(/labels/);
    expect(find(tools, 'board_vocabulary')).toMatch(/model ids/);
    expect(find(tools, 'list_projects')).toMatch(/ARMED/);
  });

  it('tells the asker a timed-out question is still on screen, and how to keep waiting', async () => {
    // The runtime DEPENDS on this sentence: the card outlives the call, and a
    // retry only re-attaches to it when the words are identical. Drop the
    // instruction and the model re-asks in its own words, which raises a second
    // card and asks the person twice — the exact defect the standing card
    // exists to prevent.
    const ask = find(await everyHostTool(), HOST_QUESTION_TOOL);
    expect(ask).toMatch(/identical/i);
    expect(ask).toMatch(/same card/i);
  });

  it('makes BOTH sides of the chart/scorecard boundary name the other', async () => {
    // The pair that actually collides: a model with numbers in hand must pick
    // one. Stating the rule on one side only leaves a model reading top-down —
    // which hits show_chart first — with nothing to send it onward.
    const tools = await everyHostTool();
    expect(find(tools, HOST_CHART_TOOL)).toContain('show_metrics');
    expect(find(tools, HOST_METRICS_TOOL)).toContain('show_chart');
  });

  it('keeps propose_patch and propose_plan descriptions byte-identical in both modes', () => {
    // The BLOCKING pair is the text these two tools served before the deferred
    // mode existed, byte for byte; the DEFERRED pair is new. A drift in either
    // is a model-facing behaviour change, not a refactor detail.
    const patchDeferred =
      'Propose a change to ONE file without making it. The user sees the diff with Apply and Reject, and this ' +
      'app writes the file only if they accept. ' +
      'Use it when you have a concrete fix and would rather hand it over than edit directly — and do NOT also ' +
      'write the file yourself: if the user accepts, the change is already on disk. ' +
      'One file per call; call it again for the next one. ' +
      'The call returns at once — the card is on their screen, so STOP and end your turn. Do not write the file ' +
      'yourself, and do not call this again for the same change. What happened arrives as your next user message, ' +
      'and the four outcomes mean different things: applied (it is on disk, do not write it again), rejected ' +
      '(do NOT route around it — ask what they would prefer), stale (they ACCEPTED but the file no longer matches, ' +
      'so re-read it and propose again — this is not a refusal), and unavailable (the card could not be shown at ' +
      'all, so describe the change in your reply instead).';
    const patchBlocking =
      'Propose a change to ONE file without making it. The user sees the diff with Apply and Reject, and this ' +
      'app writes the file only if they accept. ' +
      'Use it when you have a concrete fix and would rather hand it over than edit directly — and do NOT also ' +
      'write the file yourself: if the user accepts, the change is already on disk. ' +
      'One file per call; call it again for the next one. ' +
      'The result tells you what happened, and the four outcomes mean different things: applied (it is on ' +
      'disk, do not write it again), rejected (do NOT route around it — ask what they would prefer), stale ' +
      '(they ACCEPTED but the file no longer matches, so re-read it and propose again — this is not a ' +
      'refusal), and unavailable (the card could not be shown at all, so describe the change in your reply ' +
      'instead).';
    const planBody =
      'Use it when the work is worth more than a couple of edits, when a request could reasonably be read more ' +
      'than one way, or when you are about to touch something wide — a rename across files, a dependency, a ' +
      'schema, anything hard to undo. Do not use it for work you have already been told to do, or for a ' +
      'one-line change: a plan for something obvious is a card in the way. ' +
      'If you have a plan mode of your own (an ExitPlanMode tool, or similar), use EITHER that or this, never ' +
      'both for the same piece of work — two approval cards for one plan is a gate the user has to answer ' +
      'twice. Prefer this one when it is offered: its card is the one rendered in the app they are watching. ' +
      'Call it ONCE, before the work, and do not also write the steps out as text — the user sees the card. ';
    const planTail =
      'Use show_artifact instead when you want to SHOW a plan rather than be approved for one — a laid-out ' +
      'page you keep updating as the work moves. This tool is the gate; that one is the picture, and it asks ' +
      'the user nothing.';
    const planDeferred =
      'Show the user how you intend to carry out a request, and wait for them to approve it before you start. ' +
      planBody +
      'The call returns at once — the card is on their screen, so STOP and end your turn. Do not start the work, ' +
      'and do not call this again for the same plan. Their verdict arrives as your next user message: approved ' +
      '(carry it out), or rejected (do NOT do it another way). Either verdict may carry a note from the user — ' +
      'when it does, that note outranks the plan you proposed. ' +
      planTail;
    const planBlocking =
      'Show the user how you intend to carry out a request, and WAIT for them to approve it before you start. ' +
      planBody +
      'The call blocks until they answer, and the result is what to do next: approved (carry it out), or ' +
      'rejected (do NOT do it another way). Either verdict may carry a note from the user — when it does, that ' +
      'note outranks the plan you proposed. ' +
      planTail;

    expect(proposePatchInstructions(true)).toBe(patchDeferred);
    expect(proposePatchInstructions(false)).toBe(patchBlocking);
    expect(proposePlanInstructions(true)).toBe(planDeferred);
    expect(proposePlanInstructions(false)).toBe(planBlocking);
  });

  it('tells a deferring plan and patch that the call returns at once', async () => {
    // The blocking sentences stay for a sink that holds the call. A cursor
    // listing is the other one: the model has to stop, because the verdict
    // arrives later, as a message, and waiting on this call is how it times out.
    const plans = new PlanBroker();
    const patches = new PatchBroker();
    const noop = async (): Promise<never> => {
      throw new Error('not called');
    };
    plans.register('run-1', 'agent', noop as never, { answersAtOnce: true });
    patches.register('run-1', 'agent', noop as never, { answersAtOnce: true });
    const { json } = await post(
      service(
        new CallBroker(),
        new UserQuestionBroker(),
        new FindingsReportBroker(),
        new ChartBroker(),
        patches,
        plans,
      ),
      'run-1',
      'agent',
      rpc('tools/list', {}),
    );
    const tools = (json().result as { tools: ToolListing[] }).tools;
    const plan = find(tools, HOST_PLAN_TOOL);
    const patch = find(tools, HOST_PATCH_TOOL);
    expect(plan).toContain('returns at once');
    expect(plan).toContain('next user message');
    expect(plan).not.toContain('The call blocks');
    expect(patch).toContain('returns at once');
    expect(patch).toContain('four outcomes');
    expect(patch).toContain('next user message');
  });

  it('names ALL FOUR patch outcomes it promises', async () => {
    // It said "the four outcomes mean different things" and listed three,
    // leaving `unavailable` — the one where nothing was decided at all — for
    // the model to guess at.
    const description = find(await everyHostTool(), HOST_PATCH_TOOL);
    expect(description).toContain('four outcomes');
    for (const outcome of ['applied', 'rejected', 'stale', 'unavailable']) {
      expect(description, `outcome ${outcome} unmentioned`).toContain(outcome);
    }
  });

  it('disambiguates the two tools claude ships its own version of', async () => {
    // Measured in the claude 2.1.247 binary: `ReportFindings` and
    // `ExitPlanMode` are both in there. `ExitPlanMode` is REACHABLE from
    // geniro, since `plan` is one of the four approval modes a chat can run
    // under — so a model can genuinely hold both tools at once.
    const tools = await everyHostTool();
    expect(find(tools, HOST_FINDINGS_TOOL)).toContain('ReportFindings');
    expect(find(tools, HOST_PLAN_TOOL)).toContain('ExitPlanMode');
  });

  it('tells every DRAWING tool to call once and not restate the data', async () => {
    // The bargain the whole family makes: the payload is the card and the
    // result is a receipt, so a model that also writes the data out has put it
    // on screen twice and spent its context for the privilege.
    const tools = await everyHostTool();
    for (const name of [
      HOST_FINDINGS_TOOL,
      HOST_CHART_TOOL,
      HOST_METRICS_TOOL,
      HOST_COMPARISON_TOOL,
      HOST_GALLERY_TOOL,
      HOST_ARTIFACT_TOOL,
    ]) {
      const description = find(tools, name);
      expect(description, `${name} never says ONCE`).toContain('ONCE');
      expect(description, `${name} never says "do not also"`).toContain(
        'do not also',
      );
    }
  });

  it('gives every host tool a WHEN — and every card tool a WHEN NOT', async () => {
    // A description that only says what a tool does gets called whenever it
    // could apply rather than when it should.
    const tools = await everyHostTool();
    for (const name of [
      HOST_QUESTION_TOOL,
      HOST_FINDINGS_TOOL,
      HOST_CHART_TOOL,
      HOST_METRICS_TOOL,
      HOST_COMPARISON_TOOL,
      HOST_PATCH_TOOL,
      HOST_PLAN_TOOL,
      HOST_GALLERY_TOOL,
      HOST_ARTIFACT_TOOL,
      HOST_NOTIFY_TOOL,
      HOST_SEARCH_CHATS_TOOL,
      HOST_READ_CHAT_CONTEXT_TOOL,
      HOST_ANALYZED_THREAD_TOOL,
      HOST_RECOMMENDATIONS_TOOL,
      HOST_RECOMMENDATION_MARKS_TOOL,
      HOST_WORKFLOW_CHANGE_TOOL,
      HOST_PUBLISH_ACTION_TOOL,
      HOST_REMOVE_ACTION_TOOL,
      ...HOST_BOARD_TOOLS,
    ]) {
      expect(find(tools, name), `${name} never says when`).toMatch(
        /Use it (when|whenever)/,
      );
    }
    for (const name of [
      HOST_QUESTION_TOOL,
      HOST_FINDINGS_TOOL,
      HOST_COMPARISON_TOOL,
      HOST_PLAN_TOOL,
      HOST_GALLERY_TOOL,
      HOST_ARTIFACT_TOOL,
      HOST_NOTIFY_TOOL,
      HOST_RECOMMENDATIONS_TOOL,
      HOST_RECOMMENDATION_MARKS_TOOL,
      HOST_WORKFLOW_CHANGE_TOOL,
      HOST_PUBLISH_ACTION_TOOL,
      ...HOST_BOARD_TOOLS,
    ]) {
      expect(find(tools, name), `${name} never says when NOT`).toMatch(
        /(Do NOT use it|Do not use it|instead\.|write a table instead)/,
      );
    }
  });

  it('sends a SINGLE picture to markdown rather than to the gallery', async () => {
    // The gallery's real neighbour is not another tool — it is the markdown
    // image that already renders in this transcript. Without the boundary a
    // model reaches for the card for one screenshot, which costs a click to
    // see something that would have been inline.
    const description = find(await everyHostTool(), HOST_GALLERY_TOOL);

    expect(description).toContain('SEVERAL');
    expect(description).toMatch(/!\[.*\]\(.*\)/);
  });

  it('makes BOTH sides of the plan/artifact boundary name the other', async () => {
    // The pair that actually collides: an agent with a plan in hand can reach
    // for either, and they do opposite things — one BLOCKS on the user, the
    // other only shows. Stating it on one side leaves a model reading top-down
    // with nothing to send it onward, which is the chart/scorecard defect.
    const tools = await everyHostTool();
    expect(find(tools, HOST_ARTIFACT_TOOL)).toContain('propose_plan');
    expect(find(tools, HOST_PLAN_TOOL)).toContain('show_artifact');
  });

  it('sends each fixed shape to the sibling that already draws it', async () => {
    // show_artifact can express any of them, so without these names a model
    // reaches for a hand-written page where a themed, tested card exists.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    for (const sibling of [
      HOST_CHART_TOOL,
      HOST_METRICS_TOOL,
      HOST_COMPARISON_TOOL,
      HOST_GALLERY_TOOL,
    ]) {
      expect(description, `${sibling} unmentioned`).toContain(sibling);
    }
  });

  it('says which libraries load and that nothing else reaches the network', async () => {
    // Neither is guessable by trying: a library from an allowed CDN works, a
    // fetch() or a remote image fails without an error and the page renders
    // half-blank.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    expect(description).toMatch(/CDN/);
    expect(description).toMatch(/no network of its own/i);
    // geniro-base sits above Tailwind's `base` (or the reset zeroes the body
    // padding), so a page's own `@layer base` rule loses to it — said up front.
    expect(description).toMatch(/@layer base[^.]*unlayered/);
    expect(description).toContain("geniro.chart('#el', option)");
  });

  it('names only tokens, kit classes and Tailwind colours the page runtime defines', async () => {
    // Read OUT of the description, so a name it promises and nothing defines
    // — a renamed class, a dropped token — fails here instead of leaving an
    // agent's page silently unstyled.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    const expand = (names: string[]): string[] =>
      names.flatMap((name) =>
        name === 'chart-1…5'
          ? ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
          : [name],
      );

    const tokens = expand(
      [...description.matchAll(/--geniro-([a-z0-9-]+(?:…5)?)/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(tokens.length).toBeGreaterThan(15);
    const renderer = readFileSync(
      join(__dirname, '../../../../../ui/src/renderer/chats/artifact-theme.ts'),
      'utf8',
    );
    for (const token of tokens) {
      expect(ARTIFACT_TOKEN_NAMES, `--geniro-${token}`).toContain(token);
      expect(renderer, `--geniro-${token} is never sent`).toContain(
        `'--geniro-${token}':`,
      );
    }

    const classes = [...description.matchAll(/\bg-[a-z]+(?:-[a-z]+)*/g)].map(
      (m) => m[0],
    );
    expect(classes.length).toBeGreaterThan(15);
    for (const name of classes) {
      expect(ARTIFACT_KIT_STYLE, `.${name}`).toMatch(
        new RegExp(`\\.${name}(?![a-z-])`),
      );
    }
    // The badge variants are written as suffixes (`g-badge (+ -success, …)`),
    // which the class scan above cannot see — so they are read out of the
    // description too, rather than checked against a list written here.
    const badgeVariants = (
      /g-badge \(\+ ([^)]*)\)/.exec(description)?.[1] ?? ''
    )
      .split(/,\s*/)
      .map((v) => v.replace(/^-/, '').trim())
      .filter(Boolean);
    expect(badgeVariants.length).toBeGreaterThan(2);
    for (const variant of badgeVariants) {
      expect(ARTIFACT_KIT_STYLE, `.g-badge-${variant}`).toContain(
        `.g-badge-${variant})`,
      );
    }

    const tailwind = description.slice(
      description.indexOf('Tailwind https'),
      description.indexOf('are the app theme'),
    );
    const colours = expand(
      [...tailwind.matchAll(/\b(?:bg|text|border)-([a-z0-9-]+(?:…5)?)/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(colours.length).toBeGreaterThan(5);
    for (const colour of colours) {
      expect(ARTIFACT_TAILWIND_THEME, `--color-${colour}`).toContain(
        `--color-${colour}:`,
      );
    }
  });

  it('names only library URLs the page’s own policy admits', async () => {
    // A URL the CSP refuses fails silently inside the page, so a description
    // naming one would send every model to a blank chart.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    const urls = description.match(/https:\/\/[^\s"'<>),;]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(5);
    // Read per DIRECTIVE: a script URL only style-src admits fails as surely
    // as one nothing admits.
    const sourcesOf = (directive: string): string[] =>
      (
        ARTIFACT_PAGE_CSP.split('; ').find((part) =>
          part.startsWith(`${directive} `),
        ) ?? ''
      )
        .split(' ')
        .filter((token) => token.startsWith('https://'));
    const admitted = (url: string, sources: string[]): boolean =>
      sources.some((source) =>
        source.endsWith('/')
          ? url.startsWith(source)
          : url.startsWith(`${source}/`),
      );
    for (const url of urls) {
      const directive = url.endsWith('.css') ? 'style-src' : 'script-src';
      expect(url, `${url} has no file type the page can load`).toMatch(
        /\.(js|css)$/,
      );
      expect(
        admitted(url, sourcesOf(directive)),
        `${url} is not admitted by ${directive}`,
      ).toBe(true);
    }
  });

  it('tells the agent how to revise a page rather than publish a second one', async () => {
    // The only revisable row in the family, and the mechanism is invisible
    // from the schema alone: reusing the id is what makes a plan stay current
    // instead of leaving five stale copies in the panel.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    expect(description).toMatch(/SAME artifact_id/);
  });

  it('states the picture limits the publish step enforces, in the policy’s own units', async () => {
    // The description is the only place a model learns how large a picture may
    // be. Each figure is read off the constant the store enforces, so the text
    // cannot drift from the refusal it announces.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    expect(description).toContain(
      `${megabytes(MAX_ARTIFACT_IMAGE_BYTES)} MB each`,
    );
    expect(description).toContain(
      `${megabytes(MAX_ARTIFACT_PAGE_IMAGE_BYTES)} MB in all`,
    );
    expect(description).toContain(
      `${MAX_ARTIFACT_PAGE_IMAGES} different pictures per page`,
    );
    expect(description).toMatch(/an svg is refused/);
    expect(description).toMatch(/REFUSES the whole page/);
  });

  it('gives an example picture path inside a folder the store admits', async () => {
    // The example is what a model copies first. A path outside /tmp, the
    // system temp folder or the project folder is refused at publish, so the
    // example has to sit under a root the store actually admits.
    const description = find(await everyHostTool(), HOST_ARTIFACT_TOOL);
    const example = /<img src="([^"]+)"/.exec(description)?.[1];
    expect(example).toBeDefined();
    expect(example!.startsWith('/tmp/')).toBe(true);
  });

  it('says in the html field that a picture goes in by path, and what the html limit is', async () => {
    // The html size limit is the one a model cannot discover by trying: a page
    // over it is refused whole. A picture named by its path adds only the path.
    const tools = await everyHostTool();
    const html =
      tools.find((t) => t.name === HOST_ARTIFACT_TOOL)?.inputSchema.properties
        .html?.description ?? '';
    expect(html).toContain(`${MAX_ARTIFACT_HTML_BYTES / 1024}KB`);
    expect(html).toMatch(/absolute path/);
    expect(html).toMatch(/not as a data: URI/);
  });

  it('tells cancel_agent when cancelling is RIGHT and when it is not', async () => {
    // The fourth call tool joins this audit for the reason the card tools are in
    // it: a description that only says what the tool DOES gets called whenever
    // it could apply. This one spends the user's money in one direction
    // (finishing pointless work) and throws it away in the other (cancelling a
    // callee that was merely slow), so both sides have to be named.
    //
    // The neighbour it must point at is `await_agent(timeout_ms)` — the actual
    // answer to "this is taking a long time", and the reason it is the sentence
    // pinned here rather than a general caution.
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as { tools: { name: string; description: string }[] }
    ).tools;
    const cancel = tools.find((t) => t.name === 'cancel_agent')!.description;

    expect(cancel).toContain('POINTLESS');
    expect(cancel).toMatch(/Do NOT cancel/);
    expect(cancel).toContain('SLOW');
    expect(cancel).toContain('await_agent');
    // Ownership is enforced by the broker, and SAID here — a caller that reads
    // it never tries to stop a sibling's call and never has to be refused.
    expect(cancel).toMatch(/only cancel a call you started yourself/i);
    // And the spend is the user's to hear about: the callee's work is discarded.
    expect(cancel).toContain('discarded');
  });

  it('lists list_agent_threads beside call_agent, and makes each point at the other about resuming', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as {
        tools: { name: string; description: string; _meta?: unknown }[];
      }
    ).tools;
    const listing = find(tools, 'list_agent_threads');
    // When to use it, what it answers, and when not to.
    expect(listing).toContain('BEFORE you continue');
    // It states each conversation's size and the refusal, and steers toward
    // neither continuing nor starting over.
    expect(listing).toContain('`tokens`');
    expect(listing).toContain('`percent`');
    expect(listing).toContain('resume_refused');
    expect(listing).not.toMatch(/advice|start_fresh/);
    expect(listing).not.toContain('Continue a conversation');
    expect(listing).not.toMatch(/\binstead\b/);
    expect(listing).toMatch(/expired/i);
    expect(listing).toContain('Do not use it');
    expect(listing).toContain('call_agent');
    const call = tools.find((t) => t.name === 'call_agent')!;
    expect(call.description).not.toContain('list_agent_threads');
    expect(JSON.stringify(call)).toContain('list_agent_threads');
    expect(JSON.stringify(call)).toContain('CACHE_EXPIRED');
    expect(JSON.stringify(call)).toContain(
      "context size in tokens and as a percent of its model's window",
    );
    expect(tools.find((t) => t.name === 'list_agent_threads')?._meta).toEqual(
      tools.find((t) => t.name === 'await_agent')?._meta,
    );
  });

  it('answers list_agent_threads from the broker for THIS conversation', async () => {
    const callBroker = broker();
    const spy = vi.spyOn(callBroker, 'listThreads');
    const { json } = await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', { name: 'list_agent_threads', arguments: {} }),
    );
    const result = json().result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(spy).toHaveBeenCalledWith('run-1', 'orch');
    // A turn answering a call lists its OWN conversation's threads.
    await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', { name: 'list_agent_threads', arguments: {} }),
      'call-1',
    );
    expect(spy).toHaveBeenLastCalledWith('run-1', callerKey('orch', 'call-1'));
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: 'ok',
      result: { threads: [] },
    });

    const { json: refused } = await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'list_agent_threads',
        arguments: { agent: 'helper' },
      }),
    );
    expect(
      (refused().result as { content: { text: string }[] }).content[0]!.text,
    ).toContain('unknown argument');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('passes resume_cold through to the broker, and refuses it without a thread', async () => {
    const callBroker = broker();
    const spy = vi.spyOn(callBroker, 'callAgent');
    const { json: refused } = await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: {
          agent: 'helper',
          message: 'm',
          title: 'T',
          resume_cold: true,
        },
      }),
    );
    const refusal = (refused().result as { content: { text: string }[] })
      .content[0]!.text;
    expect(refusal).toContain('INVALID_ARGS');
    expect(refusal).toContain("'resume_cold' only applies with 'thread'");
    expect(spy).not.toHaveBeenCalled();

    const { json: notBoolean } = await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: {
          agent: 'helper',
          message: 'm',
          title: 'T',
          thread: 'call-1',
          resume_cold: 'yes',
        },
      }),
    );
    expect(
      (notBoolean().result as { content: { text: string }[] }).content[0]!.text,
    ).toContain("'resume_cold' must be true or false");
    expect(spy).not.toHaveBeenCalled();

    // A model filling the optional flag with `false` on a NEW call is not
    // refused — there is nothing to resume, and nothing it asked for.
    await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: {
          agent: 'helper',
          message: 'm',
          title: 'T',
          resume_cold: false,
        },
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);

    await post(
      service(callBroker),
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: {
          agent: 'helper',
          message: 'm',
          title: 'T',
          thread: 'call-1',
          resume_cold: true,
        },
      }),
    );
    expect(spy).toHaveBeenCalledWith(
      'run-1',
      'orch',
      expect.objectContaining({ thread: 'call-1', resumeCold: true }),
      expect.anything(),
    );
  });

  it('makes message_agent and cancel_agent name each other — a correction is not a cancellation', async () => {
    // The pair a caller holding a user's correction must choose between: cancel
    // throws away everything the callee already did right, and message_agent
    // exists so that is not the only way to change a running call.
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as { tools: { name: string; description: string }[] }
    ).tools;
    const message = find(tools, 'message_agent');

    expect(message).toContain('cancel_agent');
    // A callee that PAUSED is answered, not messaged.
    expect(message).toContain('answer_agent');
    // A finished call is continued, not messaged.
    expect(message).toContain('thread');
    expect(find(tools, 'cancel_agent')).toContain('message_agent');
  });

  it('spells out BOTH things a message_agent delivery can do, and names no CLI', async () => {
    // What a delivery does to the callee is a fact about the callee's CLI: one
    // joins the message to its running turn, another stops the step in flight
    // and answers the message instead. The receipt says which, per delivery, so
    // this text — read before any delivery — has to cover both. It also may not
    // say which CLI does which: that fact belongs to the CLI's adapter, and a
    // copy here goes stale unnoticed.
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as { tools: { name: string; description: string }[] }
    ).tools;

    const message = find(tools, 'message_agent');
    expect(message).toMatch(/next tool boundary/);
    expect(message).toMatch(/step in flight/);
    expect(message).toContain('not delivered');
    expect(message).toContain('at your next turn');

    // Every tool in the listing, not only this one: the same sentence could be
    // written into any of its siblings.
    const cliNames = Object.values(AgentKind).map(
      (kind) => kind.split('-')[0] ?? kind,
    );
    for (const { name, description } of tools) {
      for (const cli of cliNames) {
        expect(description.toLowerCase(), `${name} names ${cli}`).not.toContain(
          cli,
        );
      }
    }
  });

  it('tells the gallery to name FILES rather than paste image data', async () => {
    // The one way this tool's payload differs from every other card's: it
    // carries paths and the app reads the files. A model that base64s an image
    // into `path` produces a tile that can never load, and the failure is
    // silent — the row persists and the picture is simply missing.
    const description = find(await everyHostTool(), HOST_GALLERY_TOOL);

    expect(description).toContain('Do not paste');
  });
});
