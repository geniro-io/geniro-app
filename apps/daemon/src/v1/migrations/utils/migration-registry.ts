import type { Migration } from '../migrations.types';
import { appMigrationsJournal } from './m0001-app-migrations-journal';
import { workflowToTeamNames } from './m0002-workflow-to-team-names';
import { teamLibraryFiles } from './m0003-team-library-files';

/** Every migration, in the order a profile applies them. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  appMigrationsJournal,
  workflowToTeamNames,
  teamLibraryFiles,
];
