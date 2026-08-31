import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Seeder } from '@mikro-orm/seeder';
import type { EntityManager } from '@mikro-orm/sqlite';

import { Item } from '../../v1/runs/entity/item.entity';
import { Run } from '../../v1/runs/entity/run.entity';
import type { ItemKind } from '../../v1/runs/runs.types';

/**
 * Conversations that put the chat surface's harder states on screen, so they
 * can be looked at without waiting for a thread to produce them by chance.
 *
 * Every one of these is a state that took a real thread to reach — several
 * reviews open at once, four detached commands still running, a title long
 * enough to fight the header for room. They are otherwise reachable only by
 * doing the work that produces them, which is minutes of an agent's time per
 * screenshot and not repeatable.
 *
 * **The pull requests are REAL and public.** The renderer resolves each ref
 * through the user's own `gh` (`main/github-prs.ts`), so a fabricated URL comes
 * back unresolved and draws the row's fallback — which is a different branch
 * from the one being looked at, and passes for it. Three open ones come from
 * `cli/cli` because this repo rarely has three at once; the merged ones are
 * this repo's own.
 *
 * Written through the ENTITIES rather than as SQL, which is the point of
 * seeding through the ORM at all: `pullRequests` is a serialized column and
 * `payload` is another, so a hand-written INSERT is two chances to store a
 * shape the app cannot read, and it silently renders as an empty thread.
 */
export class UiFixturesSeeder extends Seeder {
  override async run(em: EntityManager): Promise<void> {
    const cwd = process.env.GENIRO_SEED_CWD ?? process.cwd();
    await clearPreviousFixtures(em);

    // THREE chips, each narrower than a lone one, plus `All 6`.
    this.chat(em, {
      id: 'shelf-three-open',
      title: 'Shelf — three open pull requests',
      minutesAgo: 4,
      cwd,
      pullRequests: [...OPEN, ...MERGED],
      items: [say('open a few reviews'), reply('Done.'), turnComplete()],
    });

    // The gallery card, with EVERY tile state on screen at once — two that
    // load, one uncaptioned, one whose file has moved, and one naming a remote
    // source. The last two are the point: a dead tile and a refused scheme each
    // say what is wrong in their own words rather than showing a broken box,
    // and neither takes the rest of the set down with it. The markdown image in
    // the reply above it is the same picture reached the other way, which is
    // what makes the shared zoom viewer comparable between the two.
    this.chat(em, {
      id: 'gallery-card',
      title: 'Gallery — a set of pictures, and the ways a tile can fail',
      minutesAgo: 2,
      // This fixture's own cwd, NOT the shared one: its tiles name real files
      // in this repository, and the renderer resolves a relative gallery path
      // against the RUN's cwd. The shared `cwd` is `process.cwd()`, which is
      // `apps/daemon` under the documented `pnpm --filter @geniro/daemon seed`
      // — so every tile, including the two this fixture exists to show
      // loading, would render "could not be read".
      cwd: REPO_ROOT,
      items: [
        say('show me the app imagery'),
        reply(
          'Here is the icon on its own:\n\n![the app icon](apps/ui/resources/icon.png)\n\nand the whole set below.',
        ),
        gallery('App imagery', [
          {
            path: 'apps/ui/resources/icon.png',
            caption: 'icon.png — relative to the run cwd',
          },
          {
            path: 'apps/ui/src/renderer/assets/logo.png',
            caption: 'logo.png',
          },
          { path: 'apps/ui/resources/icon.png' },
          {
            path: 'apps/ui/resources/moved-away.png',
            caption: 'a file that is not there',
          },
          {
            path: 'https://example.com/remote.png',
            caption: 'a remote source',
          },
        ]),
        turnComplete(),
      ],
    });

    // ONE wide chip and `All 4` — what a thread on a single branch has always
    // shown, kept here so the change is visibly scoped to the several case.
    this.chat(em, {
      id: 'shelf-one-open',
      title: 'Shelf — one open, three merged',
      minutesAgo: 9,
      cwd,
      pullRequests: [OPEN[0]!, ...MERGED],
      items: [say('ship the fix'), reply('Merged.'), turnComplete()],
    });

    // NOTHING open: the newest settled one still earns a chip, because "this
    // thread produced this" is worth naming even when nothing is left to do.
    this.chat(em, {
      id: 'shelf-all-settled',
      title: 'Shelf — all settled',
      minutesAgo: 26,
      cwd,
      pullRequests: MERGED,
      items: [say('tidy up'), reply('All merged.'), turnComplete()],
    });

    // The `Terminals` chip, the `background` tag, and a clock column holding
    // widths from `7s` to `1h` — which is the case that made the tags on two
    // rows sit at two different x positions before the clock was a column.
    //
    // Every row here OPENS: clicking one asks the daemon for that command's own
    // output, so the rows carry real files (`writeShellLog`) rather than only
    // describing commands. Two of them are ANNOUNCED the way the CLI announces
    // one — naming the log — and two stop short of it, which is the shape
    // `readLaunchHandle` refuses; those two are listed only because `shell_open`
    // says they were detached. Both halves have to be here, or the fixture
    // proves whichever one it happens to contain.
    const shells = writeShellLogs();
    this.chat(em, {
      id: 'shells-detached',
      title: 'Shells — four detached commands',
      minutesAgo: 2,
      cwd,
      items: [
        say('start the servers'),
        // ANNOUNCED — its log is named, so a `BashOutput` probe could find it
        // and the output dialog reads it straight away.
        ...detached('toolu_seed_a1', 'pnpm dev', 3_600, shells.dev),
        // LIVE: a real process appending a line a second, bounded so it cannot
        // outlive the afternoon. The output dialog POLLS a running command, and
        // this is the only row where that is observable.
        ...detached('toolu_seed_b2', shells.live.command, 20, shells.live.log),
        // UNANNOUNCED — the reply stops at the id, so only `shell_open` puts
        // these on screen.
        ...detached('toolu_seed_c3', 'tail -f /var/log/system.log', 7),
        ...detached(
          'toolu_seed_d4',
          'docker compose -f infra/compose.dev.yaml up --build --force-recreate',
          41,
        ),
        reply('Four are running.'),
        turnComplete(),
      ],
    });

    // The WHOLE SHELF at once — a pull request, a task list, delegates still
    // out and a command still running, which is the one arrangement that shows
    // the row's durable → volatile order doing its job. It is also the only
    // fixture whose run is LIVE (see `status` on `chat`): a delegate reads as
    // running only while the run has not settled, and the count on the
    // sub-agent chip is the running half.
    this.chat(em, {
      id: 'shelf-fan-out',
      title: 'Shelf — a fan-out with a task list',
      minutesAgo: 1,
      cwd,
      status: 'running',
      pullRequests: [OPEN[0]!, ...MERGED],
      items: [
        say('review the shelf change across the renderer and the daemon'),
        taskList([
          { id: '1', title: 'read the composer shelf', status: 'completed' },
          { id: '2', title: 'read the agents panel', status: 'completed' },
          {
            id: '3',
            title: 'check the chip ordering',
            status: 'in_progress',
            activeForm: 'checking the chip ordering',
          },
          { id: '4', title: 'write the specs', status: 'pending' },
          { id: '5', title: 'run the full check', status: 'pending' },
          { id: '6', title: 'screenshot every state', status: 'pending' },
        ]),
        ...delegate(
          'toolu_seed_e1',
          'audit the token usage',
          'Find every hardcoded colour in the renderer.',
        ),
        ...delegate(
          'toolu_seed_e2',
          'trace the shell fold',
          'Follow shell_open from the daemon to the shelf chip.',
        ),
        ...delegate(
          'toolu_seed_e3',
          'read the pull-request capture',
          'Explain when the capture runs and what it broadcasts.',
        ),
        ...delegate(
          'toolu_seed_e4',
          'check the header specs',
          'List what chat-header.spec.tsx still pins.',
          'The header pins its two halves and the figures readout.',
        ),
        ...detached('toolu_seed_e5', 'pnpm --filter @geniro/ui test:unit', 34),
        reply('Four delegates are out; I am on step three.'),
      ],
    });

    // What the header gives up first, now the folder chip has left the side
    // that holds the truncating title.
    this.chat(em, {
      id: 'header-long-title',
      title:
        'Header — a deliberately very long conversation title that has to give way before the figures do',
      minutesAgo: 51,
      cwd,
      pullRequests: [OPEN[1]!],
      items: [say('hello'), reply('Hi.'), turnComplete()],
    });
  }

  private chat(
    em: EntityManager,
    spec: {
      /** Stable across runs — see {@link clearPreviousFixtures}. */
      id: string;
      title: string;
      minutesAgo: number;
      cwd: string;
      /**
       * `completed` unless the fixture is ABOUT a live thread.
       *
       * A `running` row is only true for as long as this daemon lives: the next
       * boot reconciles every orphaned running chat run to `failed`, on purpose
       * (`ChatService`), because a run whose process died mid-turn must not sit
       * there claiming to work. So a fixture that needs one is a re-seed away
       * rather than permanent — which is fine, since seeding takes a second and
       * the alternative is a seeder that writes rows the daemon is right to
       * distrust.
       */
      status?: 'completed' | 'running';
      pullRequests?: PullRequestRef[];
      items: SeedItem[];
    },
  ): void {
    const at = new Date(Date.now() - spec.minutesAgo * 60_000);
    const run = em.create(Run, {
      id: fixtureId(spec.id),
      status: spec.status ?? 'completed',
      title: spec.title,
      cwd: spec.cwd,
      agentKind: 'claude',
      approval: 'ask',
      createdAt: at,
      updatedAt: at,
      pullRequests:
        spec.pullRequests === undefined
          ? null
          : JSON.stringify(
              spec.pullRequests.map((ref, index) => ({
                ...ref,
                seq: index + 1,
              })),
            ),
      // PAST the transcript, so the daemon's own capture pass reads `seq >
      // marker`, finds nothing, and leaves these refs alone. Left at 0 it
      // rescans from the start, captures none (no `gh pr create` here) and
      // writes the empty result back over them.
      pullRequestsScannedSeq: 999_999,
    });
    spec.items.forEach((item, index) => {
      const itemAt = new Date(Date.now() - (item.secondsAgo ?? 0) * 1000);
      em.create(Item, {
        runId: run.id,
        seq: index + 1,
        kind: item.kind,
        role: item.role ?? null,
        payload: JSON.stringify(item.payload),
        createdAt: item.secondsAgo === undefined ? at : itemAt,
        updatedAt: item.secondsAgo === undefined ? at : itemAt,
      });
    });
  }
}

interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

interface SeedItem {
  kind: ItemKind;
  role?: string | null;
  payload: unknown;
  /** When it landed, for rows whose CLOCK is the thing being looked at. */
  secondsAgo?: number;
}

const ref = (owner: string, repo: string, number: number): PullRequestRef => ({
  owner,
  repo,
  number,
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
});

/** Open, on a repository that reliably has several at once. */
const OPEN: PullRequestRef[] = [
  ref('cli', 'cli', 14294),
  ref('cli', 'cli', 14292),
  ref('cli', 'cli', 14285),
];
/** Merged, and this repo's own. */
const MERGED: PullRequestRef[] = [
  ref('geniro-io', 'geniro-app', 78),
  ref('geniro-io', 'geniro-app', 77),
  ref('geniro-io', 'geniro-app', 76),
];

/**
 * This repository's root, derived from THIS FILE rather than from the process.
 *
 * The gallery fixture names real images in the repo, and the renderer resolves
 * a relative gallery path against the run's own cwd — so the fixture must know
 * where the repo is regardless of where the seeder was invoked from. Deriving
 * it from `__dirname` is what makes the fixture work under the documented
 * `pnpm --filter @geniro/daemon seed` (cwd `apps/daemon`) as well as from the
 * repo root. Dev-only code, run through `@swc-node/register` on the source, so
 * `__dirname` is this directory.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

const say = (text: string): SeedItem => ({
  kind: 'message',
  role: 'user',
  payload: { text },
});
const reply = (text: string): SeedItem => ({
  kind: 'message',
  role: 'assistant',
  payload: { text },
});
const turnComplete = (): SeedItem => ({
  kind: 'turn_complete',
  payload: { usage: { costUsd: 0.42, durationMs: 21_000 } },
});

/**
 * A set of pictures an agent handed over (`show_gallery`).
 *
 * The one render-family card that cannot be looked at without a fixture, and
 * for a sharper reason than the rest of this file: the others are merely SLOW
 * to reach, while this one is unreachable by construction — the row is written
 * only by `GalleryBroker.draw`, registered per live turn, so short of prompting
 * a real CLI into calling the tool there is no way to get one on screen.
 *
 * The paths are the repo's OWN images, referenced relative to the run's cwd,
 * because that is the form the tool documents and the one the renderer resolves
 * through the image route. Two of the entries are deliberately broken — see the
 * fixture that uses this.
 */
const gallery = (
  title: string,
  images: { path: string; caption?: string }[],
): SeedItem => ({
  kind: 'show_gallery',
  payload: { title, images },
});

/**
 * One detached command, as the transcript records it — the launching call, the
 * daemon's `shell_open`, and the CLI's reply.
 *
 * `logPath` decides which of the two launch replies is written, and the choice
 * is the whole reason both exist. WITH one, the reply is the CLI's full
 * announcement, `ShellOutputService` parses the path out of it and the output
 * dialog shows the command's real output. WITHOUT one, the reply stops at the
 * id — the shape `readLaunchHandle` refuses — so the row is on screen only
 * because `shell_open` says the call was detached, which is the change this
 * fixture exists to exercise. Give every row the full announcement and the
 * fixture passes whether or not that row is read at all.
 */
function detached(
  callId: string,
  command: string,
  secondsAgo: number,
  logPath?: string,
): SeedItem[] {
  return [
    {
      kind: 'tool_call',
      secondsAgo,
      payload: {
        id: callId,
        name: 'Bash',
        input: { command, run_in_background: true },
      },
    },
    {
      kind: 'shell_open',
      secondsAgo,
      payload: { id: callId, workId: `w_${callId}` },
    },
    {
      kind: 'tool_result',
      secondsAgo,
      payload: {
        id: callId,
        name: 'Bash',
        result:
          logPath === undefined
            ? `Command running in background with ID: w_${callId}.`
            : `Command running in background with ID: w_${callId}. Output is being written to: ${logPath}.`,
        isError: false,
      },
    },
  ];
}

/**
 * One delegate, as the transcript records it — the launching `Task` call and
 * the daemon's own announcement about it.
 *
 * A block is admitted two ways and this uses BOTH, which is what a fixture
 * should do: the call is named `Task` (`AGENT_TOOLS`, claude's spelling) and a
 * `subagent_info` row names the same call id (the route a CLI whose delegation
 * frame carries no usable name takes). `report` is what ENDS it — pass none and
 * the delegate is still out, which is the state the shelf's count is about.
 */
function delegate(
  callId: string,
  label: string,
  prompt: string,
  report?: string,
): SeedItem[] {
  return [
    {
      kind: 'tool_call',
      payload: {
        id: callId,
        name: 'Task',
        input: { description: label, prompt, subagent_type: 'Explore' },
      },
    },
    {
      kind: 'subagent_info',
      payload: { id: callId, label, kind: 'Explore', prompt },
    },
    ...(report === undefined
      ? []
      : [
          {
            kind: 'tool_result' as ItemKind,
            payload: {
              id: callId,
              name: 'Task',
              result: report,
              isError: false,
            },
          },
        ]),
  ];
}

/** The agent's own checklist, as one SNAPSHOT announcement. */
const taskList = (
  tasks: { id: string; title: string; status: string; activeForm?: string }[],
): SeedItem => ({
  kind: 'task_list',
  payload: {
    mode: 'snapshot',
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      activeForm: task.activeForm ?? null,
    })),
  },
});

/**
 * The prefix every fixture's run id carries, and the whole of what makes
 * re-seeding SAFE.
 *
 * Borrowed from the sibling `price-crawler-platform`'s seeding rules, which are
 * the clearest statement of this anywhere in these repos: upsert on a natural
 * key, or delete-then-insert SCOPED to an owner key — and never `deleteAll`,
 * because a seed shares its tables with rows the runtime owns. Here the runtime
 * owns every real conversation, so a scope is not a nicety: the first draft of
 * this seeder wrote fresh UUIDs and left five more fixture chats in the sidebar
 * on every run, which is the same defect one step milder.
 */
const FIXTURE_ID_PREFIX = 'seed-fixture-';

const fixtureId = (name: string): string => `${FIXTURE_ID_PREFIX}${name}`;

/**
 * Drop what a PREVIOUS seed left, and nothing else.
 *
 * Scoped by the id prefix, so a chat the user started is untouched even when it
 * sits in the same database. `hardDelete` and not the soft one, because a
 * fixture is not history: a soft-deleted run keeps its id, and the next seed
 * would then collide on the primary key rather than replacing anything.
 *
 * The other tables are deliberately LEFT ALONE — the same repo's rule that
 * runtime state is not a seed's to touch. `usage_events` is an append-only
 * spend ledger the Stats page reads and is exempt even from run teardown;
 * `node_state` belongs to the graph executor. Neither has anything to do with
 * these chats.
 */
async function clearPreviousFixtures(em: EntityManager): Promise<void> {
  const runs = await em.find(
    Run,
    { id: { $like: `${FIXTURE_ID_PREFIX}%` } },
    { fields: ['id'] },
  );
  if (runs.length === 0) {
    return;
  }
  const ids = runs.map((run) => run.id);
  await em.nativeDelete(Item, { runId: { $in: ids } });
  await em.nativeDelete(Run, { id: { $in: ids } });
  // The identity map still holds what the `find` above loaded, and a
  // `nativeDelete` does not tell it otherwise. Without this, `em.create(Run, {
  // id })` for the SAME id returns a MANAGED entity and the flush issues an
  // UPDATE against a row that no longer exists — so the second seed of a
  // database silently produced no runs at all, and the third then doubled the
  // items (with no runs to find, this function returned early and deleted
  // nothing). Measured: 5 runs / 27 items, then 0 / 27, then 5 / 54.
  em.clear();
}

/**
 * The output files behind the shell rows — so a terminal on this fixture OPENS
 * onto something rather than onto "nothing written yet".
 *
 * A row that cannot be opened tests half the feature: the list is one surface
 * and `shell-output-dialog.tsx` is the other, and the second is where the ANSI
 * rendering, the tail bound and the follow-the-newest-line behaviour live.
 *
 * `pnpm dev`'s log is WRITTEN OUT rather than run, and carries real SGR escape
 * sequences — which is what `ansi-text` exists for and what no plain echo would
 * produce. They are spelled as `\u001b` escapes rather than as the byte: the
 * repo's own pre-commit hook refuses a `.ts` file git would classify as binary,
 * and the escape and the byte are the same code unit at runtime.
 */
function writeShellLogs(): {
  dev: string;
  live: { command: string; log: string };
} {
  // The SYSTEM temp dir, not the userData one, and that is a correctness
  // requirement rather than tidiness: `ShellOutputService` parses the path
  // out of the CLI's prose with `(\\S+?)`, so it stops at the first SPACE —
  // and a macOS userData path contains one (`Application Support`), which
  // made every seeded terminal report `the output file is gone`. The real
  // CLI writes these under `/tmp`, so this is also the more faithful
  // fixture. Worth knowing the parser cannot address a path with a space in
  // it at all; no shipped CLI puts one there.
  const dir = join(tmpdir(), 'geniro-seed-shells');
  mkdirSync(dir, { recursive: true });

  const green = '\u001b[32m';
  const yellow = '\u001b[33m';
  const dim = '\u001b[2m';
  const off = '\u001b[0m';
  const dev = join(dir, 'pnpm-dev.log');
  writeFileSync(
    dev,
    [
      `${dim}> geniro-app@0.1.0 dev${off}`,
      `${green}\u2713${off} daemon listening on ${yellow}127.0.0.1:47615${off}`,
      `${green}\u2713${off} renderer ready in ${yellow}412ms${off}`,
      `${dim}17:04:11${off} page reload ${dim}src/renderer/chats/shell-list.tsx${off}`,
      `${green}\u2713${off} rebuilt in ${yellow}88ms${off}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  // A REAL process, because polling is only observable against a file that is
  // still growing — and BOUNDED, which is what makes it safe to put in a
  // fixture at all. Nothing in this repo would reap it: the daemon's child
  // journal only knows children the DAEMON spawned, so an endless loop here
  // would outlive every window and be nobody's to stop. 1800 seconds outlasts a
  // session of hand-testing and not the day. Detached and unref'd so the seeder
  // can exit while it runs.
  const log = join(dir, 'watch-build.log');
  writeFileSync(log, '', { mode: 0o600 });
  const command = 'pnpm --filter @geniro/ui build --watch';
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'for i in $(seq 1 1800); do date "+%T  rebuilt in 88ms"; sleep 1; done',
    ],
    { detached: true, stdio: ['ignore', openSync(log, 'a'), 'ignore'] },
  );
  child.unref();

  return { dev, live: { command, log } };
}
