import type { Migration } from '../migrations.types';
import { appMigrationsJournal } from './m0001-app-migrations-journal';

/** Every migration, in the order a profile applies them. Append only. */
export const MIGRATIONS: readonly Migration[] = [appMigrationsJournal];
