import { Seeder } from '@mikro-orm/seeder';
import type { EntityManager } from '@mikro-orm/sqlite';

import {
  HOST_QUESTION_TOOL,
  type HostQuestion,
} from '../../v1/agents/chat.types';
import {
  hostCardQuestions,
  hostQuestionCardInput,
} from '../../v1/agents/utils/host-question';
import { serializePendingQuestion } from '../../v1/agents/utils/pending-question';
import { CommandCenterRosterEntry } from '../../v1/command-center/entity/command-center-roster.entity';
import {
  clearFixtureRuns,
  FIXTURE_ID_PREFIX,
  fixtureId,
  reply,
  say,
  seedCwd,
  type SeedItem,
  turnComplete,
  writeChat,
} from './ui-fixtures.seeder';

/** The environment variable naming the stand scenarios one seed run writes. */
export const STAND_SCENARIOS_ENV = 'GENIRO_SEED_SCENARIOS';

const STAND_PREFIX = `${FIXTURE_ID_PREFIX}stand-`;

export const STAND_SCENARIO_NAMES = [
  'waiting-question',
  'long-transcript',
] as const;

export type StandScenarioName = (typeof STAND_SCENARIO_NAMES)[number];

export type StandScenariosContext = { scenarios: readonly StandScenarioName[] };

/**
 * The scenarios `GENIRO_SEED_SCENARIOS` names, in the order they are known.
 *
 * Unset or blank means none. `all` means every scenario. Anything unknown
 * throws before a row is written, so a typo never leaves a half-seeded profile.
 */
export function standScenariosFrom(
  value: string | undefined,
): StandScenarioName[] {
  const named = (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (named.length === 0) {
    return [];
  }
  if (named.includes('working-threads')) {
    throw new Error(
      `"working-threads" needs a live daemon: start it with node scripts/stand/boot.mjs <worktree> --seed working-threads`,
    );
  }
  const unknownNames = named.filter(
    (name) => name !== 'all' && !isStandScenarioName(name),
  );
  if (unknownNames.length > 0) {
    throw new Error(
      `unknown stand scenario ${unknownNames.map((name) => `"${name}"`).join(', ')} in ${STAND_SCENARIOS_ENV} — known: ${[...STAND_SCENARIO_NAMES, 'all'].join(', ')}`,
    );
  }
  const every = named.includes('all');
  return STAND_SCENARIO_NAMES.filter((name) => every || named.includes(name));
}

function isStandScenarioName(name: string): name is StandScenarioName {
  return (STAND_SCENARIO_NAMES as readonly string[]).includes(name);
}

/** Writes the named scenarios under the stand prefix, replacing the previous ones. */
export class StandScenariosSeeder extends Seeder<StandScenariosContext> {
  override async run(
    em: EntityManager,
    context: StandScenariosContext,
  ): Promise<void> {
    await clearFixtureRuns(em, STAND_PREFIX);
    const cwd = seedCwd();
    for (const name of context.scenarios) {
      SCENARIOS[name](em, cwd);
    }
  }
}

type Scenario = (em: EntityManager, cwd: string) => void;

const SCENARIOS: Record<StandScenarioName, Scenario> = {
  'waiting-question': writeWaitingQuestion,
  'long-transcript': writeLongTranscript,
};

const WAITING_QUESTIONS: HostQuestion[] = [
  {
    header: 'Fix',
    question: 'Which fix should the login redirect take?',
    options: [
      {
        label: 'Clear the stale session',
        description:
          'Sign the user out first, then send them to the sign-in page. The smaller change.',
      },
      {
        label: 'Follow the return address',
        description:
          'Keep the session and send the user back to the page they asked for.',
      },
    ],
  },
  {
    header: 'Scope',
    question: 'Should the fix cover sign-in on paired devices too?',
    options: [
      {
        label: 'Desktop only',
        description: 'Ship it for the app window now.',
      },
      {
        label: 'Desktop and paired devices',
        description: 'Also change the sign-in a phone or tablet goes through.',
      },
    ],
  },
];

/**
 * A thread waiting on an answer, and the command center that relays it.
 *
 * `pendingQuestion` is what a boot reads back to make the card answerable; the
 * roster row lets the boot's own review relay it. No relay row is seeded: that
 * one is the boot's to write.
 */
function writeWaitingQuestion(em: EntityManager, cwd: string): void {
  const requestId = fixtureId('stand-question');
  writeChat(em, {
    id: 'stand-waiting-thread',
    title: 'Fix the login redirect loop',
    minutesAgo: 6,
    cwd,
    items: [
      say(
        'The sign-in page sends me back to itself after I log in. Please fix it.',
      ),
      reply(
        'There are two ways to fix this. I need your choice before I change the code.',
      ),
      {
        kind: 'approval_request',
        payload: {
          id: requestId,
          toolName: HOST_QUESTION_TOOL,
          input: hostQuestionCardInput(null, WAITING_QUESTIONS),
          questions: hostCardQuestions(WAITING_QUESTIONS),
        },
      },
    ],
    extra: {
      pendingQuestion: serializePendingQuestion({
        kind: 'question',
        requestId,
        title: null,
        questions: WAITING_QUESTIONS,
      }),
    },
  });
  const joinedAt = new Date();
  em.create(
    CommandCenterRosterEntry,
    {
      managerRunId: fixtureId('stand-command-center'),
      threadRunId: fixtureId('stand-waiting-thread'),
      handle: 't1',
      reason: 'auto',
      note: null,
      joinedAt,
      leftAt: null,
      finishNewsSince: joinedAt,
    },
    { partial: true },
  );
  writeChat(em, {
    id: 'stand-command-center',
    title: 'Command center',
    minutesAgo: 5,
    cwd,
    items: [
      say('What is waiting on me?'),
      reply('One thread is waiting for your answer.'),
      turnComplete(),
    ],
    extra: { commandCenter: true },
  });
}

const LONG_TRANSCRIPT_STEPS = 100;
const LONG_REPLY_EVERY = 25;

/** A chat several hundred rows deep, whose last message fits one screen. */
function writeLongTranscript(em: EntityManager, cwd: string): void {
  const items: SeedItem[] = [
    say('Walk the migration plan one file at a time.'),
  ];
  for (let step = 1; step <= LONG_TRANSCRIPT_STEPS; step += 1) {
    const callId = `stand-long-${step}`;
    items.push(
      say(`Check step ${step}.`),
      {
        kind: 'tool_call',
        payload: {
          id: callId,
          name: 'Read',
          input: { file_path: `apps/daemon/src/db/migrations/step-${step}.ts` },
        },
      },
      {
        kind: 'tool_result',
        payload: {
          id: callId,
          name: 'Read',
          result: `export const step${step} = { up: 'ALTER TABLE items ADD COLUMN note TEXT' };`,
          isError: false,
        },
      },
      reply(
        step % LONG_REPLY_EVERY === 0
          ? longReply(step)
          : `Step ${step} is clean.`,
      ),
    );
  }
  items.push(
    reply('All 100 steps check out. The migration is ready for review.'),
    turnComplete(),
  );
  writeChat(em, {
    id: 'stand-long-transcript',
    title: 'Migration plan — every step',
    minutesAgo: 12,
    cwd,
    items,
  });
}

function longReply(step: number): string {
  const paragraph = `Step ${step} changes the column type and keeps the old values readable, so a rollback needs no data copy. The reader accepts both shapes until the next release.`;
  return Array.from(
    { length: 8 },
    (_, index) => `${index + 1}. ${paragraph}`,
  ).join('\n\n');
}
