import {
  copyFile,
  lstat,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { Logger } from '@nestjs/common';
import { parseDocument } from 'yaml';

import { atomicWrite } from '../../../utils/atomic-file';
import { TeamYamlSchema } from '../../teams/teams.types';
import {
  isLegacyTeamGraph,
  teamFromLegacyDocument,
} from '../../teams/utils/team-from-workflow';
import { serializeTeamYaml } from '../../teams/utils/team-yaml';
import { type FileMigration, MIGRATION_BACKUPS_DIR } from '../migrations.types';

/** Frozen with the migration, so a later rename of the store's own names cannot change what this step does. */
const LIBRARY_DIR = 'teams';
const TEAM_SUFFIX = '.team.yaml';
export const TEAM_SHAPE_FILES_ID = '0005-team-shape-files';
export const CONVERSION_NOTES_SUFFIX = '.conversion.txt';

const logger = new Logger('Migration0005');

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Rewrites every library team still written as a node graph in the team shape
 * (`teamFromWorkflow`), after copying it into the migration's backup folder;
 * what the conversion dropped or widened (agent → agent data edges, call edges)
 * is written beside the copy as `<file>.conversion.txt` and logged. A file that
 * already is a team, that does not parse, or whose conversion the strict schema
 * would refuse is left as it is: the legacy reader still serves it, and the
 * editor names what to fix. `down` copies every backup's files back, the
 * earliest copy of each file last.
 */
export const teamShapeFiles: FileMigration = {
  id: TEAM_SHAPE_FILES_ID,
  kind: 'files',
  async up({ userDataDir, backup }) {
    const library = join(userDataDir, LIBRARY_DIR);
    if (!(await exists(library))) {
      return;
    }
    for (const name of (await readdir(library)).sort()) {
      if (!name.endsWith(TEAM_SUFFIX)) {
        continue;
      }
      const path = join(library, name);
      const source = await readFile(path, 'utf8');
      const doc = parseDocument(source);
      if (doc.errors.length > 0) {
        continue;
      }
      const value: unknown = doc.toJS();
      if (!isLegacyTeamGraph(value)) {
        continue;
      }
      const legacy = teamFromLegacyDocument(value);
      if (!legacy.success) {
        logger.warn(`${name} left as it is: ${legacy.error}`);
        continue;
      }
      const strict = TeamYamlSchema.safeParse(legacy.converted.team);
      if (!strict.success) {
        logger.warn(
          `${name} left as it is: converted it would not load (${strict.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')})`,
        );
        continue;
      }
      const copy = backup(path);
      const { notes } = legacy.converted;
      if (notes.length > 0) {
        await writeFile(
          join(dirname(copy), `${basename(copy)}${CONVERSION_NOTES_SUFFIX}`),
          `${notes.join('\n')}\n`,
        );
        for (const note of notes) {
          logger.log(`${name}: ${note}`);
        }
      }
      await atomicWrite(path, serializeTeamYaml(legacy.converted.team));
    }
  },
  async down({ userDataDir }) {
    const backups = join(userDataDir, MIGRATION_BACKUPS_DIR);
    if (!(await exists(backups))) {
      return;
    }
    const folders = (await readdir(backups))
      .filter((name) => name.startsWith(`${TEAM_SHAPE_FILES_ID}-`))
      .sort()
      .reverse();
    for (const folder of folders) {
      const saved = join(backups, folder, LIBRARY_DIR);
      if (!(await exists(saved))) {
        continue;
      }
      for (const name of await readdir(saved)) {
        if (name.endsWith(TEAM_SUFFIX)) {
          await copyFile(
            join(saved, name),
            join(userDataDir, LIBRARY_DIR, name),
          );
        }
      }
    }
  },
};
