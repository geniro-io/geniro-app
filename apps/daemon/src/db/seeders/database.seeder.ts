import { Seeder } from '@mikro-orm/seeder';
import type { EntityManager } from '@mikro-orm/sqlite';

import { environment } from '../../environments';
import { UiFixturesSeeder } from './ui-fixtures.seeder';

/**
 * The default seeder — what `pnpm --filter @geniro/daemon seed` runs.
 *
 * It exists to compose the others and to hold the ONE guard they all need, so
 * no individual seeder can be written without it.
 *
 * **Seeding is for a THROWAWAY database.** Every other data-writing path in
 * this daemon is driven by something the user did; a seeder writes rows nobody
 * asked for, into whatever database `environment.dbPath` happens to resolve to
 * — which is `GENIRO_USER_DATA`, and which the Electron shell sets to the
 * user's real profile every time it launches. That is the whole hazard: a
 * seeder run in the wrong shell drops fabricated conversations into the store
 * holding months of real ones, and there is no undo, since the chats are the
 * user's own data rather than anything git tracks.
 *
 * So this refuses to run against the INSTALLED app's userData, by name. The
 * check is a `startsWith` on the directory rather than a match on the file,
 * because everything the app owns lives beside the database — a seeder that
 * spared `geniro.db` and wrote attachments next to it would be no safer.
 * Setting `GENIRO_SEED_FORCE=1` is the deliberate override, and it exists so
 * the refusal never becomes something to work around by editing this file.
 */
export class DatabaseSeeder extends Seeder {
  override async run(em: EntityManager): Promise<void> {
    assertDisposableDatabase();
    await this.call(em, [UiFixturesSeeder]);
  }
}

/**
 * The directories a packaged Geniro keeps a real profile in.
 *
 * `Geniro` is what `productName` resolves to on macOS — in development too,
 * which is exactly why a dev shell needs `GENIRO_UI_USER_DATA` to get a
 * directory of its own. `~/.geniro` is the daemon's own fallback for a
 * standalone launch (`pnpm daemon:dev`), and while that one is not the
 * installed app's, it IS where a user's headless runs would have accumulated.
 */
function protectedUserDataDirs(): string[] {
  const home = process.env.HOME ?? '';
  return [
    `${home}/Library/Application Support/Geniro`,
    `${home}/.geniro`,
  ].filter(() => home !== '');
}

function assertDisposableDatabase(): void {
  if (process.env.GENIRO_SEED_FORCE === '1') {
    return;
  }
  const dir = environment.userDataDir;
  // Exact, or a child of it. `Geniro-dev` must NOT match `Geniro`, which a bare
  // `startsWith` on the string would do — hence the separator.
  const guarded = protectedUserDataDirs().find(
    (root) => dir === root || dir.startsWith(`${root}/`),
  );
  if (guarded === undefined) {
    return;
  }
  throw new Error(
    `refusing to seed ${dir} — that is a real Geniro profile, and seeding ` +
      `writes conversations nobody asked for into it. Point ` +
      `GENIRO_USER_DATA at a throwaway directory (the dev shell's is ` +
      `"$HOME/Library/Application Support/Geniro-dev"), or set ` +
      `GENIRO_SEED_FORCE=1 if you genuinely mean this one.`,
  );
}
