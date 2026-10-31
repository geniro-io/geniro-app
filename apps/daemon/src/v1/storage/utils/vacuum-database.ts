import { Worker } from 'node:worker_threads';

/** How long the worker's connection waits for a write lock another holds. */
const VACUUM_BUSY_TIMEOUT_MS = 60_000;

/**
 * Raw SQL by necessity: no builder expresses `VACUUM`, and it is recorded as an
 * exception in `.claude/rules/database-queries.md`. Constants only.
 */
const VACUUM_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.file, { timeout: workerData.busyTimeoutMs });
try {
  db.exec('VACUUM');
} finally {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}
parentPort.postMessage('done');
`;

/**
 * Rewrite the database file without its free pages, on a connection of its
 * own in a worker thread: better-sqlite3 is synchronous, so on the daemon's own
 * connection the statement would hold the event loop — every request, health
 * check included — for as long as it runs. Under WAL readers keep reading;
 * a writer on another connection gives up after its busy timeout, so it runs
 * only before the daemon serves anything (`StorageService.compactIfScheduled`).
 * The checkpoint runs whether or not the VACUUM succeeded: a failed one (a
 * full disk) leaves its pages in the WAL, the size of the database.
 */
export function vacuumDatabase(
  file: string,
  driver: string = require.resolve('better-sqlite3'),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER_SOURCE, {
      eval: true,
      workerData: { file, driver, busyTimeoutMs: VACUUM_BUSY_TIMEOUT_MS },
    });
    let done = false;
    worker.once('message', () => {
      done = true;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (done) {
        resolve();
      } else {
        reject(
          new Error(`the compaction stopped before it finished (${code})`),
        );
      }
    });
  });
}
