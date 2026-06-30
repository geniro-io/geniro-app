import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { Item } from '../runs/entity/item.entity';
import { Run } from '../runs/entity/run.entity';
import type { AgentKind, ItemKind, RunStatus } from '../runs/runs.types';
import { AgentEventBus } from './agent-events.bus';
import type { ItemWire, RunWire } from './chat.types';
import { ClaudeExecutor } from './claude.adapter';
import { CursorExecutor } from './cursor.adapter';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import type { AgentEvent, Executor } from './executor.types';
import { ProcessRegistry } from './process-registry';

/**
 * The single-agent chat has exactly one node; its CLI session id is keyed under
 * this constant in `node_state` (whose PK is runId+nodeId). `Item.nodeId` stays
 * null for single-agent transcript rows, per the entity contract.
 */
const SINGLE_AGENT_NODE = 'agent';

/** Map a normalized event to the persisted transcript item it becomes. */
function mapEventToItem(
  event: AgentEvent,
): { kind: ItemKind; role: string | null; payload: unknown } | null {
  switch (event.type) {
    case 'session':
      return null; // captured into node_state, not a transcript item
    case 'text':
      return {
        kind: 'message',
        role: 'assistant',
        payload: { text: event.text },
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        role: 'assistant',
        payload: { text: event.text },
      };
    case 'tool_call':
      return {
        kind: 'tool_call',
        role: 'assistant',
        payload: { id: event.id, name: event.name, input: event.input },
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        role: 'tool',
        payload: {
          id: event.id,
          name: event.name,
          result: event.result,
          isError: event.isError,
        },
      };
    case 'turn_complete':
      return {
        kind: 'turn_complete',
        role: null,
        payload: { usage: event.usage, stopReason: event.stopReason },
      };
    case 'turn_cancelled':
      return { kind: 'turn_cancelled', role: null, payload: {} };
    case 'error':
      return { kind: 'error', role: null, payload: { message: event.message } };
  }
}

/** The run status a terminal event implies, or null for a mid-turn event. */
function terminalStatus(event: AgentEvent): RunStatus | null {
  switch (event.type) {
    case 'turn_complete':
      return 'completed';
    case 'error':
      return 'failed';
    case 'turn_cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Orchestrates a single-agent chat: validates the run's cwd, drives the chosen
 * adapter, and applies **persist-then-emit** — every item is written (allocating
 * its monotonic seq) BEFORE it is published on the bus, so the durable
 * transcript is the source of truth and a reconnecting client can replay it. The
 * CLI session id is captured into `node_state` for `--resume`.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly claude: ClaudeExecutor,
    private readonly cursor: CursorExecutor,
  ) {}

  async createChat(input: {
    agentKind: AgentKind;
    cwd: string;
    model?: string;
    title?: string;
  }): Promise<RunWire> {
    const cwd = this.resolveValidCwd(input.cwd);
    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        workflowId: null,
        status: 'pending',
        agentKind: input.agentKind,
        cwd,
        model: input.model ?? null,
        title: input.title ?? null,
      },
      em,
    );
    return this.toRunWire(run);
  }

  async listChats(): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listChats(em);
    return runs.map((run) => this.toRunWire(run));
  }

  async getHistory(runId: string, afterSeq = -1): Promise<ItemWire[]> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const items = await this.itemDao.getByRun(runId, afterSeq, em);
    return items.map((item) => this.itemToWire(item));
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    return { cancelled: this.registry.cancel(runId) };
  }

  /**
   * Persist the user message, then start a turn whose streamed events are each
   * persisted-then-emitted. Returns the persisted user item immediately; the
   * agent's reply streams over the bus → WS while this method has already
   * resolved.
   */
  async sendMessage(runId: string, text: string): Promise<ItemWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    if (run.workflowId) {
      throw new BadRequestException(
        'NOT_A_CHAT_RUN',
        'run is not a single-agent chat',
      );
    }
    if (!run.cwd || !run.agentKind) {
      throw new BadRequestException(
        'RUN_NOT_CONFIGURED',
        'run is missing a working directory or agent',
      );
    }
    // Reserve the run synchronously BEFORE any further await — this closes the
    // check-then-act window where two concurrent messages would both pass the
    // busy check, share one `maxSeq` base, allocate colliding seq values (the
    // renderer then de-dupes by seq and silently drops one), and spawn two CLIs.
    if (!this.registry.tryClaim(runId)) {
      throw new ConflictException(
        'RUN_BUSY',
        'a turn is already in progress for this run',
      );
    }
    try {
      const cwd = this.resolveValidCwd(run.cwd);
      const agentKind = run.agentKind;
      const model = run.model ?? undefined;

      let seq = (await this.itemDao.maxSeq(runId, em)) + 1;
      const userWire = await this.persist(em, runId, seq++, 'message', 'user', {
        text,
      });

      const node = await this.nodeStateDao.getByRunNode(
        runId,
        SINGLE_AGENT_NODE,
        em,
      );
      const resumeSessionId = node?.agentSessionId ?? null;
      let savedSessionId = resumeSessionId;
      await this.runDao.updateById(runId, { status: 'running' }, em);

      const executor: Executor =
        agentKind === 'claude' ? this.claude : this.cursor;
      let chain: Promise<void> = Promise.resolve();
      let sawTerminal = false;
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(work).catch((err: unknown) => {
          this.logger.error(
            `run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      };

      const handle = executor.start(
        { prompt: text, cwd, model, resumeSessionId },
        (event) => {
          // Serialize handling so seq allocation and writes stay ordered even
          // though onEvent is a sync callback firing as stdout arrives.
          enqueue(async () => {
            if (event.type === 'session') {
              // Some CLIs repeat the session id on every line; only persist when
              // it actually changes to avoid a DB round-trip per chunk.
              if (event.sessionId !== savedSessionId) {
                savedSessionId = event.sessionId;
                await this.nodeStateDao.saveSessionId(
                  runId,
                  SINGLE_AGENT_NODE,
                  event.sessionId,
                  em,
                );
              }
              return;
            }
            const mapped = mapEventToItem(event);
            if (!mapped) {
              return;
            }
            await this.persist(
              em,
              runId,
              seq++,
              mapped.kind,
              mapped.role,
              mapped.payload,
            );
            const status = terminalStatus(event);
            if (status) {
              sawTerminal = true;
              await this.runDao.updateById(runId, { status }, em);
            }
          });
        },
      );
      this.registry.register(runId, handle);

      void handle.done
        .then(async () => {
          await chain; // drain pending persists before finalizing
          if (!sawTerminal) {
            // The turn ended with no terminal event (e.g. a clean exit with no
            // result line). Persist+emit a synthetic turn_complete so the client
            // always receives a terminal item and never wedges waiting for one.
            await this.persist(em, runId, seq++, 'turn_complete', null, {
              usage: null,
              stopReason: null,
            });
            await this.runDao
              .updateById(runId, { status: 'completed' }, em)
              .catch(() => undefined);
          }
        })
        .catch((err: unknown) => {
          this.logger.error(
            `run ${runId} turn finalize failed: ${String(err)}`,
          );
        });

      return userWire;
    } catch (err) {
      // Failed before the handle took over the slot's lifecycle — drop the claim
      // so the run is not wedged as permanently busy.
      this.registry.release(runId);
      throw err;
    }
  }

  private async persist(
    em: EntityManager,
    runId: string,
    seq: number,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): Promise<ItemWire> {
    const item = await this.itemDao.create(
      {
        runId,
        nodeId: null,
        seq,
        kind,
        role,
        payload: JSON.stringify(payload),
      },
      em,
    );
    const wire: ItemWire = {
      id: item.id,
      runId,
      nodeId: null,
      seq,
      kind,
      role,
      payload,
      createdAt: item.createdAt.toISOString(),
    };
    this.bus.publish({ runId, item: wire });
    // A turn can stream many items through this one forked EM; detach the
    // just-persisted entity so the identity map stays bounded over a long turn.
    // The DAO helpers re-query by id, so later status/session writes are correct.
    em.clear();
    return wire;
  }

  /**
   * Validate a working directory and return its canonical (symlink-resolved)
   * absolute path. Canonicalizing closes the gap where a symlinked cwd is
   * persisted un-resolved; the returned path is what gets stored and spawned in.
   * The agent is scoped to the user's chosen folder (it never defaults to the
   * daemon's own cwd, the app repo) — confining it further to an allowed root is
   * out of scope for the local-first single-user model (the user picks their own
   * project folder on their own machine).
   */
  private resolveValidCwd(cwd: string): string {
    if (!isAbsolute(cwd)) {
      throw new BadRequestException(
        'INVALID_CWD',
        'cwd must be an absolute path',
      );
    }
    let canonical: string;
    try {
      canonical = realpathSync(cwd); // resolves symlinks; throws if missing
    } catch {
      throw new BadRequestException(
        'INVALID_CWD',
        `cwd does not exist: ${cwd}`,
      );
    }
    if (!statSync(canonical).isDirectory()) {
      throw new BadRequestException(
        'INVALID_CWD',
        `cwd is not a directory: ${cwd}`,
      );
    }
    return canonical;
  }

  private toRunWire(run: Run): RunWire {
    return {
      id: run.id,
      status: run.status,
      title: run.title,
      agentKind: run.agentKind,
      cwd: run.cwd,
      model: run.model,
      createdAt: run.createdAt.toISOString(),
    };
  }

  private itemToWire(item: Item): ItemWire {
    return {
      id: item.id,
      runId: item.runId,
      nodeId: item.nodeId,
      seq: item.seq,
      kind: item.kind,
      role: item.role,
      payload: parsePayload(item.payload),
      createdAt: item.createdAt.toISOString(),
    };
  }
}
