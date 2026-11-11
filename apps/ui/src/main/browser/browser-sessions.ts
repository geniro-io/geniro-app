import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { app, type Session } from 'electron';

import type { DaemonHandle } from '../../shared/contracts';

export const PARTITION_DIR_PREFIX = 'geniro-browser-';
const OWN_PARTITION_PREFIX = `${PARTITION_DIR_PREFIX}own-`;

export const chatPartition = (runId: string): string =>
  `persist:${PARTITION_DIR_PREFIX}${runId}`;

export const ownCookiePartition = (id: string): string =>
  `${OWN_PARTITION_PREFIX}${id}`;

/** Where Chromium keeps a chat's persisted jar. */
export const chatPartitionDir = (userDataDir: string, runId: string): string =>
  join(userDataDir, 'Partitions', `${PARTITION_DIR_PREFIX}${runId}`);

const configured = new WeakMap<Session, Promise<void>>();
const reservedDownloadPaths = new Set<string>();

/**
 * Applies the egress proxy and the page policy to one browser session. The
 * app's default session keeps its black-hole proxy and is never passed here.
 */
export function configureBrowserSession(
  session: Session,
  proxyPort: number,
): Promise<void> {
  const existing = configured.get(session);
  if (existing !== undefined) {
    return existing;
  }
  const pending = applyConfiguration(session, proxyPort);
  configured.set(session, pending);
  pending.catch(() => configured.delete(session));
  return pending;
}

async function applyConfiguration(
  session: Session,
  proxyPort: number,
): Promise<void> {
  await session.setProxy({
    proxyRules: `http://127.0.0.1:${proxyPort}`,
    proxyBypassRules: '<-loopback>',
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (_event, item) => {
    const savePath = uniqueDownloadPath(
      app.getPath('downloads'),
      basename(item.getFilename()),
    );
    reservedDownloadPaths.add(savePath);
    item.once('done', () => reservedDownloadPaths.delete(savePath));
    item.setSavePath(savePath);
  });
}

function uniqueDownloadPath(directory: string, filename: string): string {
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  const taken = (path: string): boolean =>
    reservedDownloadPaths.has(path) || existsSync(path);
  let candidate = join(directory, filename);
  for (let copy = 1; taken(candidate); copy += 1) {
    candidate = join(directory, `${stem} (${copy})${extension}`);
  }
  return candidate;
}

/**
 * Removes the on-disk jars of chats `keep` no longer vouches for. Electron
 * cannot destroy a live session, so this runs before any session for the
 * partition exists. Only `Partitions/geniro-browser-<runId>` is ever touched.
 */
export async function sweepOrphanedBrowserPartitions(
  userDataDir: string,
  keep: (runId: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  const partitionsDir = join(userDataDir, 'Partitions');
  let names: string[];
  try {
    names = await readdir(partitionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (
      !name.startsWith(PARTITION_DIR_PREFIX) ||
      name.startsWith(OWN_PARTITION_PREFIX)
    ) {
      continue;
    }
    const runId = name.slice(PARTITION_DIR_PREFIX.length);
    if (runId === '' || /[\\/]/.test(name) || (await keep(runId))) {
      continue;
    }
    await rm(chatPartitionDir(userDataDir, runId), {
      recursive: true,
      force: true,
    });
    removed.push(name);
  }
  return removed;
}

/**
 * Whether a browser jar's run still exists. Asked of each run by id, so no
 * listing's scope or page can leave one out; only the daemon's own 404 lets
 * the jar go, and any other answer or failure keeps it.
 */
export async function runStillExists(
  handle: Pick<DaemonHandle, 'host' | 'port' | 'token'>,
  runId: string,
  fetchRun: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchRun(
      `http://${handle.host}:${handle.port}/v1/chats/${encodeURIComponent(runId)}/state`,
      {
        headers: { authorization: `Bearer ${handle.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res.status !== 404;
  } catch {
    return true;
  }
}
