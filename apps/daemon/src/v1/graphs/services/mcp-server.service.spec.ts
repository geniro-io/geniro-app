import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { GENIRO_MCP_CALL_TOOLS } from '../../agents/adapters/adapter.types';
import {
  HOST_FINDINGS_TOOL,
  HOST_QUESTION_TOOL,
} from '../../agents/chat.types';
import { FindingsReportBroker } from '../../agents/services/findings-report.broker';
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
): McpServerService {
  return new McpServerService(callBroker, questions, findings, {
    token: 'launch',
    version: '9.9.9',
    startedAt: 0,
    port: 4870,
  });
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
