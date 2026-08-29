import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import {
  CHART_KINDS,
  FINDING_LEVELS,
  FINDING_OUTCOMES,
  FINDING_VERDICTS,
  HOST_CHART_TOOL,
  HOST_FINDINGS_TOOL,
  HOST_PATCH_TOOL,
  HOST_PLAN_TOOL,
  HOST_QUESTION_TOOL,
  MAX_ANSWER_LENGTH,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  MAX_FINDING_SHORT_SUMMARY_LENGTH,
  MAX_HOST_FINDINGS,
  MAX_HOST_QUESTION_OPTIONS,
  MAX_HOST_QUESTIONS,
  MAX_PLAN_STEPS,
} from '../../agents/chat.types';
import { ChartBroker } from '../../agents/services/chart.broker';
import { FindingsReportBroker } from '../../agents/services/findings-report.broker';
import { PatchBroker } from '../../agents/services/patch.broker';
import { PlanBroker } from '../../agents/services/plan.broker';
import { UserQuestionBroker } from '../../agents/services/user-question.broker';
import {
  hostChartResultText,
  readHostChart,
} from '../../agents/utils/host-chart';
import {
  hostFindingsResultText,
  readHostFindingsReport,
} from '../../agents/utils/host-findings';
import {
  hostPatchResultText,
  readHostPatch,
} from '../../agents/utils/host-patch';
import { hostPlanResultText, readHostPlan } from '../../agents/utils/host-plan';
import {
  hostQuestionResultText,
  readHostQuestions,
} from '../../agents/utils/host-question';
import { CALL_MODES, type CallEnvelope, type CallMode } from '../graphs.types';
import { CALLEE_DESCRIPTION_MAX, calleeSummary } from '../utils/callee-text';
import { closeQuietly } from '../utils/close-quietly';
import { CallBroker } from './call-broker.service';

/**
 * The MCP protocol host behind the per-run endpoint
 * (`POST /v1/mcp/<runId>/<nodeId>`, see McpController), serving the tools THIS
 * node can use over the streamable-http transport: the call surface
 * (call_agent / await_agent / answer_agent) to a node with callees,
 * `ask_user_question` to a turn whose CLI cannot ask its user anything on its
 * own, and the RENDER family — `report_findings` and `show_chart` — to a turn
 * whose transcript can draw them.
 * The listing is composed per request rather than fixed, so a chat is
 * never offered agents to call and a graph node is never offered a card
 * nobody is watching. Stateless by design: every POST builds a fresh
 * SDK `Server` + transport pair (no session ids, plain JSON responses), so
 * nothing leaks between requests and the per-run call token in the guard is
 * the only session there is.
 *
 * A CALL tool's result is always the broker's envelope
 * (`{status, result?, error?}`) serialized as text — that envelope is a
 * contract between two AGENTS. The two HOST tools answer in their own shapes
 * instead, and deliberately: neither a question put to a person nor a card
 * drawn in this app has a status, a call_id, or anything to collect later.
 *
 * Errors are answered in-protocol (JSON-RPC) inside this service: the global
 * ExceptionsFilter emits Nest-shaped `{statusCode, code, …}` bodies an MCP
 * client cannot parse, so nothing may escape to it.
 */
@Injectable()
export class McpServerService {
  private readonly logger = new Logger(McpServerService.name);

  constructor(
    private readonly broker: CallBroker,
    private readonly questions: UserQuestionBroker,
    private readonly findings: FindingsReportBroker,
    private readonly charts: ChartBroker,
    private readonly patches: PatchBroker,
    private readonly plans: PlanBroker,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
  ) {}

  /** Serve one stateless MCP request for `(run, caller node)`. */
  async handlePost(
    runId: string,
    nodeId: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Fastify must not double-send: the SDK transport writes to the raw
    // response stream directly.
    reply.hijack();
    const res = reply.raw;
    try {
      const server = this.buildServer(runId, nodeId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        closeQuietly(transport);
        closeQuietly(server);
      });
      await server.connect(transport);
      await transport.handleRequest(req.raw, res, req.body);
    } catch (err) {
      // The real message may carry internal paths — log it daemon-side, hand
      // the caller a fixed JSON-RPC error (never the Nest ExceptionsFilter's
      // {statusCode, code, …} body, which an MCP client can't parse).
      this.logger.error(
        `MCP request failed for run ${runId}/${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        );
      }
    }
  }

  /** The JSON-RPC 405 for the non-POST methods a stateless server rejects. */
  methodNotAllowed(reply: FastifyReply): void {
    void reply
      .status(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed — POST only' },
        id: null,
      });
  }

  /** One fresh, stateless SDK server scoped to (run, caller node). */
  private buildServer(runId: string, nodeId: string): Server {
    const server = new Server(
      { name: 'geniro-daemon', version: this.runtime.version },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => {
      const callees = this.broker.listCallees(runId, nodeId);
      // Each callee's own description is the routing signal — pick the agent
      // whose blurb matches the task, no hand-written roster in your role.
      const callable =
        callees
          .map((callee) => calleeSummary(callee, CALLEE_DESCRIPTION_MAX))
          .join('; ') || 'none';
      // Two independent reasons a run holds this endpoint, so the listing is
      // composed from what this node can actually DO rather than fixed: a
      // caller node has callees to reach, and a chat on a CLI that cannot ask
      // its user anything has a question to put. A node with both gets both;
      // one with neither is a node that should not have been handed an
      // endpoint at all, and an empty list says so honestly.
      const tools: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }[] = [];
      if (callees.length > 0) {
        tools.push(
          {
            name: 'call_agent',
            description:
              `Invoke one of your call-wired agents and get its result envelope. Callable now: ${callable}. ` +
              'Choose by what each agent says it does; when none of them fits the task, do it yourself or ask the user rather than forcing it on the closest one. ' +
              'A sync call can take minutes — for long tasks or parallel fan-out prefer mode "async" and collect with await_agent. ' +
              'An envelope of {"status":"question",...} means the callee PAUSED to ask you something: answer it with answer_agent ' +
              'only when your role/context makes you confident; otherwise ask the user yourself and relay their answer. ' +
              'After answering, collect the final result with await_agent(call_id).',
            inputSchema: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  description:
                    'The callee — its node id or display name from your "May call" list.',
                },
                message: {
                  type: 'string',
                  description:
                    'The task for the callee. Without `thread` it starts a FRESH conversation seeing only this text (plus its own role) — include all context it needs.',
                },
                thread: {
                  type: 'string',
                  description:
                    'Optional: a previous call_id of YOUR call to this same agent — the callee CONTINUES that conversation with its full memory. Omit to start a new thread.',
                },
                mode: {
                  type: 'string',
                  enum: [...CALL_MODES],
                  description:
                    'sync (default) waits for the result; async returns a call_id at once — collect it later with await_agent; fire_and_forget never returns a result.',
                },
              },
              required: ['agent', 'message'],
            },
          },
          {
            name: 'await_agent',
            description:
              'Collect the result envelope of one of YOUR earlier async call_agent calls (or of a sync call that paused on a question). ' +
              'Blocks until that callee finishes — or returns early with a {"status":"question"} envelope when the callee pauses to ask; ' +
              'the call stays collectable after you answer via answer_agent.',
            inputSchema: {
              type: 'object',
              properties: {
                call_id: {
                  type: 'string',
                  description: 'The call_id an async call_agent returned.',
                },
              },
              required: ['call_id'],
            },
          },
          {
            name: 'answer_agent',
            description:
              'Answer a parked question one of YOUR callees raised (a {"status":"question"} envelope carrying its call_id). ' +
              'Answer from your own role/context only when confident; when unsure, ask the user through your own question mechanism first and relay their answer verbatim. ' +
              "After answering, collect the callee's final result with await_agent(call_id). Unanswered questions time out and fail the call.",
            inputSchema: {
              type: 'object',
              properties: {
                call_id: {
                  type: 'string',
                  description:
                    'The call_id from the {"status":"question"} envelope.',
                },
                answer: {
                  type: 'string',
                  description:
                    "Your answer — an offered option's label when one fits, or free text.",
                },
              },
              required: ['call_id', 'answer'],
            },
          },
        );
      }
      if (this.questions.canAsk(runId, nodeId)) {
        tools.push({
          name: HOST_QUESTION_TOOL,
          description:
            'Ask the USER a multiple-choice question and WAIT for their answer. ' +
            'Use it when a choice is genuinely theirs to make — an ambiguous requirement, a decision between real alternatives, ' +
            'anything where guessing wrong would waste the work. Do NOT use it for questions you can answer from the code, ' +
            'and never to check in on something already decided. ' +
            'The answer comes back as text; when it cannot be put to them the result says so and you continue in your reply instead.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description:
                  'Optional short heading for the whole card, when several questions belong to one decision.',
              },
              questions: {
                type: 'array',
                description: `The questions to ask — at most ${MAX_HOST_QUESTIONS}, each with its own options.`,
                items: {
                  type: 'object',
                  properties: {
                    question: {
                      type: 'string',
                      description:
                        'The question, written so it can be answered without reading your reasoning.',
                    },
                    header: {
                      type: 'string',
                      description:
                        'A 1-3 word label for this question, used as its tab title.',
                    },
                    multiSelect: {
                      type: 'boolean',
                      description:
                        'True when more than one option may be picked. Defaults to false.',
                    },
                    options: {
                      type: 'array',
                      description: `The choices, at most ${MAX_HOST_QUESTION_OPTIONS}. Offer real alternatives; the user can always answer in their own words instead.`,
                      items: {
                        type: 'object',
                        properties: {
                          label: {
                            type: 'string',
                            description: 'The choice, in a few words.',
                          },
                          description: {
                            type: 'string',
                            description:
                              'What picking it means or leads to. Optional.',
                          },
                        },
                        required: ['label'],
                      },
                    },
                  },
                  required: ['question', 'options'],
                },
              },
            },
            required: ['questions'],
          },
        });
      }
      if (this.findings.canReport(runId, nodeId)) {
        tools.push({
          name: HOST_FINDINGS_TOOL,
          description:
            'Report code-review findings as a typed list so this app draws them for the user. ' +
            'Use it when you have reviewed code and have concrete defects to hand back — call it ONCE with every ' +
            'finding, most-severe first, and do not also print the findings as text: the user sees the rendered ' +
            'list, so writing them out again shows the same findings twice. ' +
            'An empty array is a valid report and means nothing survived your verification. ' +
            'When you later fix findings you already reported, report them again with `outcome` set on each. ' +
            'The result is a short receipt, never the findings themselves.',
          inputSchema: {
            type: 'object',
            properties: {
              level: {
                type: 'string',
                enum: [...FINDING_LEVELS],
                description:
                  'How deep the review that produced these findings ran. Optional.',
              },
              findings: {
                type: 'array',
                description: `The findings, most-severe first — at most ${MAX_HOST_FINDINGS}.`,
                items: {
                  type: 'object',
                  properties: {
                    file: {
                      type: 'string',
                      description:
                        'Repo-relative path of the file the finding is in.',
                    },
                    line: {
                      type: 'integer',
                      description:
                        'The 1-indexed line the finding anchors to. Omit rather than guessing — it is shown to the user as a location.',
                    },
                    summary: {
                      type: 'string',
                      description: 'One-sentence statement of the defect.',
                    },
                    short_summary: {
                      type: 'string',
                      description: `The claim alone, at most ${MAX_FINDING_SHORT_SUMMARY_LENGTH} characters — no rationale, no consequence clause. This is the collapsed row the user scans.`,
                    },
                    failure_scenario: {
                      type: 'string',
                      description:
                        'Concrete inputs or state, and the wrong output or crash they produce.',
                    },
                    category: {
                      type: 'string',
                      description:
                        'Short kebab-case slug of the finding type, e.g. "correctness", "security", "test-coverage". Optional.',
                    },
                    verdict: {
                      type: 'string',
                      enum: [...FINDING_VERDICTS],
                      description:
                        'Set only where a verification pass actually ran over this finding.',
                    },
                    outcome: {
                      type: 'string',
                      enum: [...FINDING_OUTCOMES],
                      description:
                        'Set ONLY when re-reporting after acting on the findings: what happened to this one.',
                    },
                  },
                  required: ['file', 'summary', 'failure_scenario'],
                },
              },
            },
            required: ['findings'],
          },
        });
      }
      if (this.charts.canDraw(runId, nodeId)) {
        tools.push({
          name: HOST_CHART_TOOL,
          description:
            'Plot numbers as a chart this app draws for the user. ' +
            'Use it whenever you have a handful of numbers worth comparing or worth seeing a trend in — timings, ' +
            'sizes, counts, coverage, spend — instead of writing them out as a table or an ASCII bar chart. ' +
            'Call it ONCE per chart, and do not also print the same numbers as text: the user sees the plot, so ' +
            'writing them out again shows the same data twice. Say what the chart shows in your reply; do not ' +
            'restate the figures. ' +
            'Every series holds one value per entry of `labels`, matched BY POSITION — the first value belongs to ' +
            'the first label, and so on. Use null for a point you did not measure; it is drawn as a gap. ' +
            'The result is a short receipt, never the numbers themselves.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description:
                  'What the chart shows, as the card\'s heading — e.g. "Test suite duration by commit".',
              },
              kind: {
                type: 'string',
                enum: [...CHART_KINDS],
                description:
                  'line for a trend over an ordered axis, bar to compare separate categories, area for a total ' +
                  'made of stacked parts.',
              },
              x_label: {
                type: 'string',
                description: 'Caption for the x axis. Optional.',
              },
              y_label: {
                type: 'string',
                description:
                  'Caption for the y axis, naming the UNIT — "seconds", "kB", "%". Optional but rarely worth ' +
                  'omitting: a number with no unit is not a measurement.',
              },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: `The x-axis categories, in the order they should be plotted — at most ${MAX_CHART_POINTS}.`,
              },
              series: {
                type: 'array',
                description: `The plotted series — at most ${MAX_CHART_SERIES}, because that is how many colours the legend can tell apart.`,
                items: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description:
                        'What this series is, as its legend entry — e.g. "unit", "integration".',
                    },
                    values: {
                      type: 'array',
                      items: { type: ['number', 'null'] },
                      description:
                        'One number per entry of `labels`, in the same order. Null for a point you did not measure.',
                    },
                  },
                  required: ['name', 'values'],
                },
              },
            },
            required: ['title', 'kind', 'labels', 'series'],
          },
        });
      }
      if (this.patches.canPropose(runId, nodeId)) {
        tools.push({
          name: HOST_PATCH_TOOL,
          description:
            'Propose a change to ONE file without making it. The user sees the diff with Apply and Reject, and this ' +
            'app writes the file only if they accept. ' +
            'Use it when you have a concrete fix and would rather hand it over than edit directly — and do NOT also ' +
            'write the file yourself: if the user accepts, the change is already on disk. ' +
            'One file per call; call it again for the next one. ' +
            'The result tells you what happened, and the four outcomes mean different things: applied (it is on disk), ' +
            'rejected (do not route around it — ask what they would prefer), and stale (they ACCEPTED but the file no ' +
            'longer matches, so re-read it and propose again).',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description:
                  'The file to change, relative to the working folder. It must be inside that folder.',
              },
              old_string: {
                type: 'string',
                description:
                  'The exact text to replace. It must appear EXACTLY ONCE in the file — include enough surrounding ' +
                  'lines to make it unique, or the patch is refused rather than applied to a guess. Omit this ' +
                  'field entirely to write the whole file (a new file, or a deliberate full rewrite).',
              },
              new_string: {
                type: 'string',
                description:
                  'The replacement text. Use an empty string to delete the matched text.',
              },
              summary: {
                type: 'string',
                description:
                  'One line saying what the change does, shown as the card\'s heading — e.g. "Raise the queue timeout to 60s".',
              },
            },
            required: ['file_path', 'new_string', 'summary'],
          },
        });
      }
      if (this.plans.canPropose(runId, nodeId)) {
        tools.push({
          name: HOST_PLAN_TOOL,
          description:
            'Show the user how you intend to carry out a request, and WAIT for them to approve it before you start. ' +
            'Use it when the work is worth more than a couple of edits, when a request could reasonably be read more ' +
            'than one way, or when you are about to touch something wide — a rename across files, a dependency, a ' +
            'schema, anything hard to undo. Do not use it for work you have already been told to do, or for a ' +
            'one-line change: a plan for something obvious is a card in the way. ' +
            'Call it ONCE, before the work, and do not also write the steps out as text — the user sees the card. ' +
            'The call blocks until they answer, and the result is what to do next: approved (carry it out), or ' +
            'rejected (do NOT do it another way). Either verdict may carry a note from the user — when it does, that ' +
            'note outranks the plan you proposed.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description:
                  'What the plan is FOR, as the card\'s heading — e.g. "Make the queue test deterministic". Say the ' +
                  'goal, not "Plan".',
              },
              steps: {
                type: 'array',
                description: `The steps in the order you would do them — at most ${MAX_PLAN_STEPS}, and fewer is better. Each is one thing you will do, not a category of work.`,
                items: {
                  type: 'object',
                  properties: {
                    title: {
                      type: 'string',
                      description:
                        'The step in one line, starting with a verb — e.g. "Replace the sleep with a wait-for".',
                    },
                    detail: {
                      type: 'string',
                      description:
                        'A sentence or two where the step needs it — the file it touches, the risk, the thing you ' +
                        'are unsure about. Optional, and better omitted than padded.',
                    },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['title', 'steps'],
          },
        });
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (name === HOST_QUESTION_TOOL) {
        // Answered ahead of the call tools and in its OWN shape: the call
        // envelope is a contract between two AGENTS, and a question put to a
        // person has no status, no call_id and nothing to collect later. The
        // agent reads plain words back.
        const questions = readHostQuestions(args);
        if (questions.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: "INVALID_ARGS: 'questions' must be a non-empty array, each entry carrying a 'question' string and at least one option.",
              },
            ],
            isError: true,
          };
        }
        const title = typeof args.title === 'string' ? args.title : null;
        const outcome = await this.questions.ask(
          runId,
          nodeId,
          questions,
          title,
        );
        return {
          content: [{ type: 'text', text: hostQuestionResultText(outcome) }],
          // None of the three outcomes is a tool FAILURE: a dismissal and an
          // unavailable channel are both answers the agent carries on from,
          // and flagging them as errors is how a model comes to retry a
          // question the user has already declined.
          isError: false,
        };
      }
      if (name === HOST_FINDINGS_TOOL) {
        // Its own shape, for the question tool's reason: a card drawn in this
        // app's transcript has no status and nothing to collect later.
        if (!Array.isArray(args.findings)) {
          return {
            content: [
              {
                type: 'text',
                text: "INVALID_ARGS: 'findings' must be an array — pass an empty one to report that nothing survived verification.",
              },
            ],
            isError: true,
          };
        }
        const report = readHostFindingsReport(args);
        // A non-empty array that parsed to nothing is a malformed call, not an
        // empty report, and the two must not answer alike: told "0 findings
        // recorded" the model believes it has reported and moves on, when in
        // fact every finding it found was dropped at this edge.
        if (args.findings.length > 0 && report.findings.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: "INVALID_ARGS: no finding could be read — each entry needs a 'file' and a 'summary' string.",
              },
            ],
            isError: true,
          };
        }
        const outcome = await this.findings.report(runId, nodeId, report);
        return {
          content: [{ type: 'text', text: hostFindingsResultText(outcome) }],
          // An unavailable channel is an answer the agent carries on from —
          // it still holds the findings and can write them in its reply.
          isError: false,
        };
      }
      if (name === HOST_CHART_TOOL) {
        const chart = readHostChart(args);
        // Null is the reader saying there is nothing plottable here at all.
        // Unlike an empty findings report — which is a real review outcome — a
        // chart of nothing is only ever a mistake, so it is answered as a
        // malformed call rather than as a drawn chart with no data.
        if (chart === null) {
          return {
            content: [
              {
                type: 'text',
                text: "INVALID_ARGS: nothing plottable — 'labels' must be a non-empty array, and 'series' must hold at least one entry with a 'name' and one measured number in 'values'.",
              },
            ],
            isError: true,
          };
        }
        const outcome = await this.charts.draw(runId, nodeId, chart);
        return {
          content: [{ type: 'text', text: hostChartResultText(outcome) }],
          // Same reading as the findings tool: an unavailable channel is an
          // answer, not a failure — the agent still holds the numbers.
          isError: false,
        };
      }
      if (name === HOST_PATCH_TOOL) {
        const read = readHostPatch(args);
        // The reader answers with a SENTENCE rather than a bare null, because
        // every refusal here names something the agent can fix and retry.
        if (!read.ok) {
          return {
            content: [{ type: 'text', text: `INVALID_ARGS: ${read.reason}` }],
            isError: true,
          };
        }
        // This one BLOCKS until the user answers the card — the only tool on
        // this endpoint besides `ask_user_question` that does.
        const outcome = await this.patches.propose(runId, nodeId, read.patch);
        return {
          content: [{ type: 'text', text: hostPatchResultText(outcome) }],
          // A rejection is not a tool failure: the user exercised the gate this
          // tool exists to offer them, and flagging it as an error is how a
          // model comes to retry a change that was just turned down.
          isError: false,
        };
      }
      if (name === HOST_PLAN_TOOL) {
        const read = readHostPlan(args);
        // A sentence, like the patch reader's: every refusal here names
        // something the agent can fix and send again.
        if (!read.ok) {
          return {
            content: [{ type: 'text', text: `INVALID_ARGS: ${read.reason}` }],
            isError: true,
          };
        }
        // BLOCKS until the user answers the card, like `propose_patch` and
        // `ask_user_question` and unlike the two drawing tools.
        const outcome = await this.plans.propose(runId, nodeId, read.plan);
        return {
          content: [{ type: 'text', text: hostPlanResultText(outcome) }],
          // A rejection is not a tool failure: the user exercised the gate this
          // tool exists to offer them, and flagging it as an error is how a
          // model comes to re-propose a plan that was just turned down.
          isError: false,
        };
      }
      let envelope: CallEnvelope;
      if (name === 'call_agent') {
        envelope =
          validateCallAgentArgs(args) ??
          (await this.broker.callAgent(runId, nodeId, {
            agent: args.agent as string,
            message: args.message as string,
            mode: args.mode as CallMode | undefined,
            thread: args.thread as string | undefined,
          }));
      } else if (name === 'await_agent') {
        envelope =
          validateAwaitAgentArgs(args) ??
          (await this.broker.awaitAgent(runId, nodeId, {
            call_id: args.call_id as string,
          }));
      } else if (name === 'answer_agent') {
        envelope =
          validateAnswerAgentArgs(args) ??
          this.broker.answerAgent(runId, nodeId, {
            call_id: args.call_id as string,
            answer: args.answer as string,
          });
      } else {
        envelope = {
          status: 'error',
          error: `UNKNOWN_TOOL: '${name}' — this endpoint serves whatever tools/list reported for this node`,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        // A question envelope is a normal outcome, not a tool failure.
        isError: envelope.status === 'error',
      };
    });

    return server;
  }
}

/** Arg validation happens in-envelope — never throw across the transport. */
function validateCallAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  if (typeof args.agent !== 'string' || args.agent.trim().length === 0) {
    return invalidArgs("'agent' must be a non-empty string");
  }
  if (typeof args.message !== 'string' || args.message.length === 0) {
    return invalidArgs("'message' must be a non-empty string");
  }
  if (args.mode !== undefined && !CALL_MODES.includes(args.mode as CallMode)) {
    return invalidArgs("'mode' must be sync, async, or fire_and_forget");
  }
  if (
    args.thread !== undefined &&
    (typeof args.thread !== 'string' || args.thread.length === 0)
  ) {
    return invalidArgs("'thread' must be a non-empty call_id string");
  }
  return null;
}

function validateAwaitAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  if (typeof args.call_id !== 'string' || args.call_id.length === 0) {
    return invalidArgs("'call_id' must be a non-empty string");
  }
  return null;
}

function validateAnswerAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  if (typeof args.call_id !== 'string' || args.call_id.length === 0) {
    return invalidArgs("'call_id' must be a non-empty string");
  }
  if (typeof args.answer !== 'string' || args.answer.trim().length === 0) {
    return invalidArgs("'answer' must be a non-empty string");
  }
  if (args.answer.length > MAX_ANSWER_LENGTH) {
    return invalidArgs(
      `'answer' exceeds ${MAX_ANSWER_LENGTH} characters — summarize it`,
    );
  }
  return null;
}

function invalidArgs(message: string): CallEnvelope {
  return { status: 'error', error: `INVALID_ARGS: ${message}` };
}
