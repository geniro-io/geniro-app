import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeferredCard,
  DeferredCardResponder,
  RunWire,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { ChatService } from '../../agents/services/chat.service';
import type { HostWakeBus } from '../../agents/services/host-wake.bus';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import type { CommandCenterService } from './command-center.service';
import type { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterNotifyService } from './command-center-notify.service';

const MANAGER = 'manager-1';
const THREAD = 'thread-1';
const REQUEST = 'req-1';
const ASK_INPUT = { questions: [{ question: 'Which cache?' }] };
const QUESTIONS = [{ question: 'Which cache?' }];
const OPTIONS = [{ id: 'redis', label: 'Redis' }];

type Db = Awaited<ReturnType<typeof commandCenterDb>>;
type Wake = Parameters<HostWakeBus['publish']>[0];
type Responder = (
  allow: boolean,
  answer?: string,
  optionId?: string,
) => boolean;
type ListChats = (
  scope: string,
  page: { runIds?: string[] },
) => Promise<RunWire[]>;
type RaiseOwnedCard = (
  runId: string,
  requestId: string,
  card: DeferredCard,
  respond: DeferredCardResponder,
) => Promise<void>;
type RetireOwnedCard = (
  runId: string,
  requestId: string,
  toolName: string,
) => Promise<void>;
type RecordOwnedCardVerdict = (
  runId: string,
  requestId: string,
  allow: boolean,
  fields: Record<string, unknown>,
) => Promise<void>;

interface RunFields {
  id: string;
  title?: string;
  status?: string;
  outcome?: { summary: string } | null;
  pullRequests?: { number: number; opened: boolean }[];
}

function runOf(fields: RunFields): RunWire {
  return {
    title: 'Billing cache',
    status: 'completed',
    awaiting: null,
    outcome: null,
    pullRequests: [],
    ...fields,
  } as unknown as RunWire;
}

describe('CommandCenterNotifyService', () => {
  let db: Db;
  let runs: Map<string, RunWire>;
  let approvals: ApprovalRegistry;
  let roster: CommandCenterRosterDao;
  let publish: ReturnType<typeof vi.fn<(wake: Wake) => void>>;
  let listChats: ReturnType<typeof vi.fn<ListChats>>;
  let raiseOwnedCard: ReturnType<typeof vi.fn<RaiseOwnedCard>>;
  let retireOwnedCard: ReturnType<typeof vi.fn<RetireOwnedCard>>;
  let recordOwnedCardVerdict: ReturnType<typeof vi.fn<RecordOwnedCardVerdict>>;
  let service: CommandCenterNotifyService;

  beforeEach(async () => {
    db = await commandCenterDb();
    runs = new Map();
    approvals = new ApprovalRegistry();
    roster = new CommandCenterRosterDao(db.em);
    publish = vi.fn<(wake: Wake) => void>();
    listChats = vi.fn<ListChats>((_scope, page) =>
      Promise.resolve(
        (page.runIds ?? []).flatMap((id) => {
          const run = runs.get(id);
          return run === undefined ? [] : [run];
        }),
      ),
    );
    raiseOwnedCard = vi.fn<RaiseOwnedCard>(() => Promise.resolve());
    retireOwnedCard = vi.fn<RetireOwnedCard>(() => Promise.resolve());
    recordOwnedCardVerdict = vi.fn<RecordOwnedCardVerdict>(() =>
      Promise.resolve(),
    );
    service = new CommandCenterNotifyService(
      db.em,
      {
        listChats,
        raiseOwnedCard,
        retireOwnedCard,
        recordOwnedCardVerdict,
      } as unknown as ChatService,
      {
        listRuns: vi.fn(() => Promise.resolve([])),
      } as unknown as TeamExecutorService,
      approvals,
      new ItemDao(db.em),
      new TaskDao(db.em),
      { publish } as unknown as HostWakeBus,
      roster,
      {
        managerRunId: vi.fn(() => Promise.resolve(MANAGER)),
      } as unknown as CommandCenterService,
      { allChanges: vi.fn() } as unknown as CommandCenterEventBus,
    );
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  function setThread(fields: RunFields): void {
    runs.set(fields.id, runOf(fields));
  }

  function firstWake(): Wake {
    const call = publish.mock.calls[0];
    if (call === undefined) {
      throw new Error('no wake was published');
    }
    return call[0];
  }

  function firstRelay(): {
    relayId: string;
    respondToCard: DeferredCardResponder;
  } {
    const call = raiseOwnedCard.mock.calls[0];
    if (call === undefined) {
      throw new Error('no card was raised');
    }
    return { relayId: call[1], respondToCard: call[3] };
  }

  async function openQuestion(
    runId: string,
    respond: Responder,
  ): Promise<void> {
    await db.seedItem(runId, 1, new Date(), 'approval_request', {
      id: REQUEST,
      toolName: 'AskUserQuestion',
      input: ASK_INPUT,
      questions: QUESTIONS,
      options: OPTIONS,
    });
    approvals.track({
      runId,
      memberId: 'member-1',
      requestId: REQUEST,
      toolName: 'AskUserQuestion',
      input: ASK_INPUT,
      question: true,
      respond,
    });
  }

  it("records a thread's first reading without waking the manager, even when it is already done", async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({
      id: THREAD,
      outcome: { summary: 'Cache cleared' },
      pullRequests: [{ number: 42, opened: true }],
    });

    await service.review(THREAD);

    expect(publish).not.toHaveBeenCalled();
  });

  it('wakes the manager once when a thread reaches done with an outcome', async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);

    setThread({
      id: THREAD,
      status: 'completed',
      outcome: { summary: 'Cache cleared' },
      pullRequests: [{ number: 42, opened: true }],
    });
    await service.review(THREAD);
    await service.review(THREAD);

    expect(publish).toHaveBeenCalledTimes(1);
    const wake = firstWake();
    expect(wake).toMatchObject({
      key: `command-center:done:${THREAD}`,
      owner: { runId: MANAGER },
    });
    expect(wake.prompt).toContain('t1');
    expect(wake.prompt).toContain('Billing cache');
    expect(wake.prompt).toContain('PR #42');
    expect(wake.prompt).toContain('Cache cleared');
  });

  it("wakes the manager once when a thread's card reaches Done", async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);

    setThread({ id: THREAD, status: 'completed' });
    await db.seedTask(THREAD, 'done');
    await service.review(THREAD);
    await service.review(THREAD);

    expect(publish).toHaveBeenCalledTimes(1);
    const wake = firstWake();
    expect(wake.key).toBe(`command-center:done:${THREAD}`);
    expect(wake.prompt).toContain('t1');
  });

  it('tells the manager nothing about status changes that never reach done', async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);
    setThread({ id: THREAD, status: 'completed' });
    await service.review(THREAD);
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);

    expect(publish).not.toHaveBeenCalled();
    expect(raiseOwnedCard).not.toHaveBeenCalled();
  });

  it('tells the manager nothing when a working thread moves to in review', async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);
    setThread({ id: THREAD, status: 'completed' });
    await db.seedTask(THREAD, 'in_review');
    await service.review(THREAD);

    expect(publish).not.toHaveBeenCalled();
    expect(raiseOwnedCard).not.toHaveBeenCalled();
  });

  it('tells the manager nothing about a thread that is not on its roster', async () => {
    const respond = vi.fn<Responder>(() => true);
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);
    setThread({
      id: THREAD,
      status: 'completed',
      outcome: { summary: 'Cache cleared' },
    });
    await openQuestion(THREAD, respond);
    await service.review(THREAD);

    expect(publish).not.toHaveBeenCalled();
    expect(raiseOwnedCard).not.toHaveBeenCalled();
  });

  it('tells the manager nothing about a thread that has left its roster', async () => {
    const respond = vi.fn<Responder>(() => true);
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    await roster.leave(MANAGER, [THREAD], new Date());
    setThread({ id: THREAD, status: 'running' });
    await service.review(THREAD);
    setThread({
      id: THREAD,
      status: 'completed',
      outcome: { summary: 'Cache cleared' },
    });
    await openQuestion(THREAD, respond);
    await service.review(THREAD);

    expect(publish).not.toHaveBeenCalled();
    expect(raiseOwnedCard).not.toHaveBeenCalled();
  });

  it('tells the manager nothing about its own run, even when that run sits on its roster', async () => {
    const respond = vi.fn<Responder>(() => true);
    await roster.join(MANAGER, [MANAGER], 'auto', new Date());
    setThread({ id: MANAGER, status: 'running' });
    await service.review(MANAGER);
    setThread({
      id: MANAGER,
      status: 'completed',
      outcome: { summary: 'Done' },
    });
    await openQuestion(MANAGER, respond);
    await service.review(MANAGER);

    expect(publish).not.toHaveBeenCalled();
    expect(raiseOwnedCard).not.toHaveBeenCalled();
  });

  it('raises one card on the manager for an open question of a roster thread', async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, title: 'Billing cache', status: 'running' });
    await openQuestion(
      THREAD,
      vi.fn<Responder>(() => true),
    );

    await service.review(THREAD);
    await service.review(THREAD);

    expect(raiseOwnedCard).toHaveBeenCalledTimes(1);
    expect(raiseOwnedCard).toHaveBeenCalledWith(
      MANAGER,
      expect.any(String),
      {
        toolName: 'thread_question',
        input: {
          threadRunId: THREAD,
          threadRequestId: REQUEST,
          handle: 't1',
          threadTitle: 'Billing cache',
          toolName: 'AskUserQuestion',
          input: ASK_INPUT,
          questions: QUESTIONS,
          options: OPTIONS,
        },
      },
      expect.any(Function),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("answers the thread's own request when the user answers the relayed card", async () => {
    const respond = vi.fn<Responder>(() => true);
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await openQuestion(THREAD, respond);
    await service.review(THREAD);

    const { relayId, respondToCard } = firstRelay();
    respondToCard(true, 'yes');

    expect(respond).toHaveBeenCalledWith(true, 'yes');
    expect(recordOwnedCardVerdict).toHaveBeenCalledWith(
      MANAGER,
      relayId,
      true,
      { answer: 'yes', outcome: 'delivered' },
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('records a verdict that reached no thread as not delivered', async () => {
    const respond = vi.fn<Responder>(() => true);
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await openQuestion(THREAD, respond);
    await service.review(THREAD);

    const { relayId, respondToCard } = firstRelay();
    approvals.resolve(THREAD, REQUEST, false);
    respondToCard(true, 'yes');

    expect(respond).toHaveBeenCalledTimes(1);
    expect(recordOwnedCardVerdict).toHaveBeenCalledWith(
      MANAGER,
      relayId,
      true,
      { answer: 'yes', outcome: 'not-delivered' },
    );
  });

  it("retires the relayed card when the thread's request closes elsewhere", async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await openQuestion(
      THREAD,
      vi.fn<Responder>(() => true),
    );
    await service.review(THREAD);

    const { relayId } = firstRelay();
    approvals.resolve(THREAD, REQUEST, true);
    await service.review(THREAD);

    expect(retireOwnedCard).toHaveBeenCalledWith(
      MANAGER,
      relayId,
      'thread_question',
    );
  });

  it('raises the card again on the next reading when raising it failed', async () => {
    await roster.join(MANAGER, [THREAD], 'auto', new Date());
    setThread({ id: THREAD, status: 'running' });
    await openQuestion(
      THREAD,
      vi.fn<Responder>(() => true),
    );
    raiseOwnedCard.mockRejectedValueOnce(new Error('manager chat archived'));

    await service.review(THREAD);
    await service.review(THREAD);

    expect(raiseOwnedCard).toHaveBeenCalledTimes(2);
  });
});
