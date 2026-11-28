import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  HOST_BROWSER_HOST_CARD,
  HOST_QUESTION_TOOL,
  HOST_THREAD_QUESTION_CARD,
  type ItemWire,
  type PromptCacheWarmupSpend,
  type RunCreatedEvent,
  type RunItemEvent,
  type UsageSignal,
} from '../../agents/chat.types';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { asRecord, asString } from '../../agents/utils/json-util';
import { KeyedChain } from '../../agents/utils/keyed-chain';
import {
  GENIRO_MCP_SERVER,
  toolMetricOf,
} from '../../agents/utils/tool-metric';
import type { AgentKind } from '../../runs/runs.types';
import type { UsageCounterKey } from '../stats.types';
import type { CapabilityId } from '../utils/capability-catalog';
import { usageKey, useDelta } from '../utils/usage-counter-delta';
import {
  commandOf,
  isCompactionRow,
  skillOf,
} from '../utils/usage-observation';
import { UsageCounterService } from './usage-counter.service';
import { UsageRegistryService } from './usage-registry.service';
import {
  type UsageRunFacts,
  UsageRunFactsService,
} from './usage-run-facts.service';

/** Ids remembered to count a delegate, a card or a listing once; the oldest go first past it. */
const SEEN_MAX = 20_000;

/** The cards geniro puts up itself, which are not a CLI asking for permission. */
const OWNED_CARD_NAMES = new Set<string>([
  HOST_BROWSER_HOST_CARD,
  HOST_THREAD_QUESTION_CARD,
]);

/** The cards that ask the user questions, beside a CLI's own question tool. */
const QUESTION_CARD_NAMES = new Set<string>([
  HOST_QUESTION_TOOL,
  HOST_THREAD_QUESTION_CARD,
]);

interface OpenCard {
  question: boolean;
  /** The tool a permission request named, when it resolves to one. */
  tool: { subject: string; source: string } | null;
  agentKind: AgentKind | null;
  projectId: string | null;
}

/** A first-in-first-out set, bounded so a long-lived daemon does not grow it. */
class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly max: number) {}

  /** Add it; false when it was already there. */
  add(item: T): boolean {
    if (this.items.has(item)) {
      return false;
    }
    if (this.items.size >= this.max) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) {
        this.items.delete(oldest);
      }
    }
    this.items.add(item);
    return true;
  }
}

/**
 * Counts the capabilities the item stream and the usage signals show — a
 * compaction, a sub-agent launched, a question or permission card and its
 * answer, a skill or slash command, an analysis or lessons run, a cache
 * warm-up, a tool list served, a Geniro tool's refusal — into the usage
 * counters. Names and outcomes only: a command's or skill's arguments and a
 * card's content are never read beyond what identifies them.
 */
@Injectable()
export class UsageObserverService implements OnModuleInit {
  private readonly logger = new Logger(UsageObserverService.name);
  private readonly work = new KeyedChain();
  private readonly delegates = new BoundedSet<string>(SEEN_MAX);
  private readonly offers = new BoundedSet<string>(SEEN_MAX);
  private readonly cards = new Map<string, OpenCard>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly adapters: AgentAdapterRegistry,
    private readonly facts: UsageRunFactsService,
    private readonly counters: UsageCounterService,
    private readonly registry: UsageRegistryService,
  ) {}

  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      void this.observe(event);
    });
    this.bus.allRunCreated().subscribe((event) => {
      void this.observeRunCreated(event);
    });
    this.bus.allPromptCacheWarmups().subscribe((spend) => {
      void this.observeWarmup(spend);
    });
    this.bus.allUsageSignals().subscribe((signal) => {
      void this.observeSignal(signal);
    });
    this.bus.allDeleted().subscribe((runId) => {
      this.work.forget(runId);
    });
  }

  /** Handle one row; never throws. */
  observe({ runId, item }: RunItemEvent): Promise<void> {
    if (!countable(item)) {
      return Promise.resolve();
    }
    return this.queue(runId, () => this.countRow(runId, item));
  }

  observeRunCreated({ runId }: RunCreatedEvent): Promise<void> {
    return this.queue(runId, async () => {
      const run = await this.facts.run(runId, this.em.fork());
      const capability = run === null ? null : analysisCapabilityOf(run);
      if (run === null || capability === null) {
        return;
      }
      this.count(
        capabilityKey(capability, run.agentKind, run.projectId),
        Date.now(),
        true,
      );
    });
  }

  observeWarmup(spend: PromptCacheWarmupSpend): Promise<void> {
    return this.queue(spend.runId, async () => {
      const run = await this.facts.run(spend.runId, this.em.fork());
      this.count(
        capabilityKey(
          'prompt_cache_warmup',
          spend.agentKind,
          run?.projectId ?? null,
        ),
        spend.occurredAt.getTime(),
        true,
      );
    });
  }

  observeSignal(signal: UsageSignal): Promise<void> {
    return this.queue(signal.runId ?? '', () => this.countSignal(signal));
  }

  private queue(key: string, work: () => Promise<void>): Promise<void> {
    return this.work.run(key, async () => {
      try {
        await work();
      } catch (err) {
        this.logger.warn(
          `a usage count was not taken: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private async countRow(runId: string, item: ItemWire): Promise<void> {
    const em = this.em.fork();
    const run = await this.facts.run(runId, em);
    if (run === null) {
      return;
    }
    const agentKind = await this.facts.agentOf(runId, item.memberId, run, em);
    const at = Date.parse(item.createdAt);
    const payload = asRecord(item.payload);
    if (isCompactionRow(payload)) {
      this.count(
        capabilityKey('compaction', agentKind, run.projectId),
        at,
        true,
      );
    }
    switch (item.kind) {
      case 'subagent_info': {
        const id = asString(payload?.id);
        if (
          id !== null &&
          this.delegates.add(
            `${runId}\u0000${item.memberId ?? ''}\u0000${item.inCall ?? ''}\u0000${id}`,
          )
        ) {
          this.count(
            capabilityKey('subagent', agentKind, run.projectId),
            at,
            true,
          );
        }
        return;
      }
      case 'tool_call': {
        const skill = skillOf(asString(payload?.name) ?? '', payload?.input);
        if (skill !== null) {
          this.count(
            usageKey(
              { subjectKind: 'skill', subject: skill, source: '' },
              agentKind,
              asString(payload?.parentToolUseId) === null
                ? 'direct'
                : 'subagent',
              run.projectId,
            ),
            at,
            true,
          );
        }
        return;
      }
      case 'message': {
        const command =
          item.role === 'user'
            ? commandOf(asString(payload?.text) ?? '')
            : null;
        if (command !== null) {
          this.count(
            usageKey(
              { subjectKind: 'command', subject: command, source: '' },
              agentKind,
              'direct',
              run.projectId,
            ),
            at,
            true,
          );
        }
        return;
      }
      case 'approval_request':
        this.openCard(runId, payload, agentKind, run, at);
        return;
      case 'approval_verdict':
        this.closeCard(runId, payload, at);
        return;
      default:
        return;
    }
  }

  private openCard(
    runId: string,
    payload: Record<string, unknown> | null,
    agentKind: AgentKind | null,
    run: UsageRunFacts,
    at: number,
  ): void {
    const id = asString(payload?.id);
    const toolName = asString(payload?.toolName) ?? '';
    const questions = payload?.questions;
    const question =
      (Array.isArray(questions) && questions.length > 0) ||
      QUESTION_CARD_NAMES.has(toolName);
    if (!question && this.isOwnedCard(toolName)) {
      return;
    }
    const capability: CapabilityId = question
      ? 'question_card'
      : 'permission_request';
    this.count(capabilityKey(capability, agentKind, run.projectId), at, true);
    if (id === null) {
      return;
    }
    if (this.cards.size >= SEEN_MAX) {
      const oldest = this.cards.keys().next().value;
      if (oldest !== undefined) {
        this.cards.delete(oldest);
      }
    }
    this.cards.set(`${runId}\u0000${id}`, {
      question,
      tool: question ? null : this.requestedTool(runId, agentKind, toolName),
      agentKind,
      projectId: run.projectId,
    });
  }

  private closeCard(
    runId: string,
    payload: Record<string, unknown> | null,
    at: number,
  ): void {
    const id = asString(payload?.id);
    const key = `${runId}\u0000${id ?? ''}`;
    const card = id === null ? undefined : this.cards.get(key);
    if (card === undefined) {
      return;
    }
    this.cards.delete(key);
    if (payload?.allow !== false) {
      return;
    }
    const refused = { refused: 1, firstAt: at, lastAt: at };
    this.counters.add(
      capabilityKey(
        card.question ? 'question_card' : 'permission_request',
        card.agentKind,
        card.projectId,
      ),
      refused,
    );
    if (card.tool !== null) {
      this.counters.add(
        usageKey(
          { subjectKind: 'tool', ...card.tool },
          card.agentKind,
          'direct',
          card.projectId,
        ),
        refused,
      );
    }
  }

  /** A card geniro put up itself: one of its own tools by its bare name, or one of its cards. */
  private isOwnedCard(toolName: string): boolean {
    return (
      OWNED_CARD_NAMES.has(toolName) || this.registry.isGeniroTool(toolName)
    );
  }

  /**
   * The tool a permission request names, when it names one: never codex's bare
   * `mcp__<server>` fallback, nor a title that is no tool's name.
   */
  private requestedTool(
    runId: string,
    agentKind: AgentKind | null,
    toolName: string,
  ): { subject: string; source: string } | null {
    if (toolName === '') {
      return null;
    }
    const metric = toolMetricOf(
      this.adapters,
      runId,
      agentKind,
      toolName,
      null,
    );
    if (
      metric.server === null &&
      (metric.tool !== toolName || metric.tool.startsWith('mcp__'))
    ) {
      return null;
    }
    return { subject: metric.tool, source: metric.server ?? '' };
  }

  private async countSignal(signal: UsageSignal): Promise<void> {
    const em = this.em.fork();
    const run =
      signal.runId === null ? null : await this.facts.run(signal.runId, em);
    const now = Date.now();
    switch (signal.kind) {
      case 'tools_offered': {
        if (
          run === null ||
          !this.offers.add(
            `${signal.runId}\u0000${signal.memberId ?? ''}\u0000${signal.conversationId ?? ''}`,
          )
        ) {
          return;
        }
        const agentKind = await this.facts.agentOf(
          signal.runId,
          signal.memberId,
          run,
          em,
        );
        for (const tool of new Set(signal.tools)) {
          this.counters.add(geniroToolKey(tool, agentKind, run.projectId), {
            offeredSessions: 1,
          });
        }
        return;
      }
      case 'geniro_tool_answered': {
        if (run === null || signal.outcome !== 'refused') {
          return;
        }
        const agentKind = await this.facts.agentOf(
          signal.runId,
          signal.memberId,
          run,
          em,
        );
        this.counters.add(
          geniroToolKey(signal.tool, agentKind, run.projectId),
          {
            refused: 1,
            firstAt: now,
            lastAt: now,
          },
        );
        return;
      }
      case 'capability':
        this.count(
          capabilityKey(
            signal.capability,
            run?.agentKind ?? null,
            run?.projectId ?? null,
          ),
          now,
          signal.ok,
        );
        return;
    }
  }

  private count(key: UsageCounterKey, at: number, ok: boolean): void {
    this.counters.add(key, useDelta(at, ok));
  }
}

const COUNTED_KINDS = new Set<string>([
  'subagent_info',
  'tool_call',
  'message',
  'approval_request',
  'approval_verdict',
]);

function countable(item: ItemWire): boolean {
  return COUNTED_KINDS.has(item.kind) || isCompactionRow(item.payload);
}

function capabilityKey(
  capability: CapabilityId,
  agentKind: string | null,
  projectId: string | null,
): UsageCounterKey {
  return usageKey(
    { subjectKind: 'capability', subject: capability, source: '' },
    agentKind,
    'direct',
    projectId,
  );
}

function geniroToolKey(
  tool: string,
  agentKind: string | null,
  projectId: string | null,
): UsageCounterKey {
  return usageKey(
    { subjectKind: 'tool', subject: tool, source: GENIRO_MCP_SERVER },
    agentKind,
    'direct',
    projectId,
  );
}

function analysisCapabilityOf(run: UsageRunFacts): CapabilityId | null {
  switch (run.analysisPurpose) {
    case 'lessons':
      return 'lessons_reflection';
    case 'lessons_check':
      return 'lessons_check';
    case 'review':
      return run.analysisTeamSlug === null
        ? 'thread_analysis'
        : 'team_analysis';
    case 'system':
      return 'system_analysis';
    default:
      return null;
  }
}
