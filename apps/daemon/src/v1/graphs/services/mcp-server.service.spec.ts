import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { GENIRO_MCP_CALL_TOOLS } from '../../agents/adapters/adapter.types';
import {
  HOST_CHART_TOOL,
  HOST_COMPARISON_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_GALLERY_TOOL,
  HOST_METRICS_TOOL,
  HOST_PATCH_TOOL,
  HOST_PLAN_TOOL,
  HOST_QUESTION_TOOL,
} from '../../agents/chat.types';
import { ChartBroker } from '../../agents/services/chart.broker';
import { ComparisonBroker } from '../../agents/services/comparison.broker';
import { FindingsReportBroker } from '../../agents/services/findings-report.broker';
import { GalleryBroker } from '../../agents/services/gallery.broker';
import { MetricsBroker } from '../../agents/services/metrics.broker';
import { PatchBroker } from '../../agents/services/patch.broker';
import { PlanBroker } from '../../agents/services/plan.broker';
import { UserQuestionBroker } from '../../agents/services/user-question.broker';
import type { RunCallCapability, WorkflowAgentNode } from '../graphs.types';
import { CallBroker } from './call-broker.service';
import { McpServerService } from './mcp-server.service';

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
      sessionId: null,
    }),
    persistItem: () => {},
    isCancelled: () => false,
    isNodeLive: () => true,
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
): McpServerService {
  return new McpServerService(
    callBroker,
    questions,
    findings,
    charts,
    patches,
    plans,
    metrics,
    comparisons,
    galleries,
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
async function everyHostTool(): Promise<
  { name: string; description: string }[]
> {
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
  for (const broker of [
    questions,
    findings,
    charts,
    patches,
    plans,
    metrics,
    comparisons,
    galleries,
  ]) {
    broker.register('run-1', 'agent', noop as never);
  }
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
    ),
    'run-1',
    'agent',
    rpc('tools/list', {}),
  );
  return (json().result as { tools: { name: string; description: string }[] })
    .tools;
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
): Promise<{ status: number; json: () => Record<string, unknown> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : undefined;
      const fastifyReq = { raw: req, body } as unknown as FastifyRequest;
      const fastifyReply = {
        raw: res,
        hijack: () => {},
      } as unknown as FastifyReply;
      void target.handlePost(runId, nodeId, fastifyReq, fastifyReply);
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
        { raw: req, body } as unknown as FastifyRequest,
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

  it('lists call_agent, await_agent, and answer_agent, naming the callable agents', async () => {
    const { json } = await post(
      service(),
      'run-1',
      'orch',
      rpc('tools/list', {}),
    );
    const tools = (
      json().result as { tools: { name: string; description: string }[] }
    ).tools;
    // Lockstep with the cursor autoApprove mirror: the endpoint's served tool
    // names ARE the list the cursor MCP entry auto-approves — a tool added here
    // without updating GENIRO_MCP_CALL_TOOLS fails this assertion.
    expect(tools.map((t) => t.name)).toEqual([...GENIRO_MCP_CALL_TOOLS]);
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

  it('offers ask_user_question — and only it — to a chat node with no callees', async () => {
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
    expect(tools.map((t) => t.name)).toEqual([HOST_QUESTION_TOOL]);
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
        arguments: { agent: 'helper', message: 'find X' },
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
        arguments: { agent: 'helper', message: 'm' },
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
      isNodeLive: () => true,
    };
    instance.registerRun('run-1', capability);
    const target = service(instance);

    const asked = await post(
      target,
      'run-1',
      'orch',
      rpc('tools/call', {
        name: 'call_agent',
        arguments: { agent: 'helper', message: 'm' },
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
describe('McpServerService — what the descriptions tell a model', () => {
  const find = (
    tools: { name: string; description: string }[],
    name: string,
  ): string => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} was not listed`).toBeDefined();
    return tool!.description;
  };

  it('makes BOTH sides of the chart/scorecard boundary name the other', async () => {
    // The pair that actually collides: a model with numbers in hand must pick
    // one. Stating the rule on one side only leaves a model reading top-down —
    // which hits show_chart first — with nothing to send it onward.
    const tools = await everyHostTool();
    expect(find(tools, HOST_CHART_TOOL)).toContain('show_metrics');
    expect(find(tools, HOST_METRICS_TOOL)).toContain('show_chart');
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

  it('tells the gallery to name FILES rather than paste image data', async () => {
    // The one way this tool's payload differs from every other card's: it
    // carries paths and the app reads the files. A model that base64s an image
    // into `path` produces a tile that can never load, and the failure is
    // silent — the row persists and the picture is simply missing.
    const description = find(await everyHostTool(), HOST_GALLERY_TOOL);

    expect(description).toContain('Do not paste');
  });
});
