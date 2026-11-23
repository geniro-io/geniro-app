import {
  ensureOwnDataDir,
  ownDataDirPath,
} from '../../agents/utils/own-data-dir';

/** The system analyses' working folder's name under the userData dir. */
export const SYSTEM_ANALYSIS_DIR_NAME = 'system-analysis';

/**
 * Where a system analysis runs: an empty folder of geniro's own, since it reads
 * threads of every project and belongs to none.
 */
export function ensureSystemAnalysisFolder(
  path: string = ownDataDirPath(SYSTEM_ANALYSIS_DIR_NAME),
): string {
  return ensureOwnDataDir(path);
}
