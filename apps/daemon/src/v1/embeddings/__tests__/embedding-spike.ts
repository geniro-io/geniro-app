import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';

import { EMBEDDING_DIM, type EmbeddingModelRef } from '../embeddings.types';
import {
  defaultWorkerLaunch,
  EmbeddingProcessService,
} from '../services/embedding-process.service';
import { Embedder } from '../worker/embedder';

/**
 * Dev-only proof that the embedding child runs under Electron's Node as the
 * daemon starts it: `pnpm --filter @geniro/daemon embeddings:spike <model dir>`.
 * Prints the numbers the pull request records; exits non-zero on any failure.
 */
const DOCS = [
  'Chat images need a path with no spaces\nA markdown image whose absolute path contains a space does not render in the chat.',
  'Run tests with package scripts\nNever invoke vitest directly; use pnpm test:unit.',
];
const QUERY = 'почему не открываются картинки в чате';

function rssMb(pid: number): number {
  return Math.round(
    Number(
      execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)])
        .toString()
        .trim(),
    ) / 1024,
  );
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    throw new Error('usage: embeddings:spike <model dir>');
  }
  const model: EmbeddingModelRef = {
    id: 'embeddinggemma-2',
    revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
    dir,
    dim: EMBEDDING_DIM,
  };
  const scratch = mkdtempSync(join(tmpdir(), 'embedding-spike-'));
  const service = new EmbeddingProcessService({
    ...defaultWorkerLaunch(),
    dbPath: join(scratch, 'embeddings.db'),
  });
  try {
    await service.setModels(model, null);
    const scores: number[] = [];
    for (let cycle = 1; cycle <= 3; cycle++) {
      const started = Date.now();
      await service.request(
        {
          op: 'index',
          source: 'memory',
          slot: 'active',
          documents: DOCS.map((text, i) => ({
            sourceId: `m${i}`,
            textHash: `h${cycle}`,
            chunks: [text],
          })),
        },
        120_000,
      );
      const loadAndIndexMs = Date.now() - started;
      const queryStart = Date.now();
      const hits = await service.request(
        {
          op: 'score',
          source: 'memory',
          query: QUERY,
          sourceIds: null,
          limit: 5,
        },
        10_000,
      );
      const queryMs = Date.now() - queryStart;
      const pid = service.pid;
      console.log(
        `cycle ${cycle}: load+index ${loadAndIndexMs} ms, query ${queryMs} ms, child rss ${pid ? rssMb(pid) : '?'} MB, hits ${JSON.stringify(hits)}`,
      );
      scores.push(
        hits.find((hit) => hit.sourceId === 'm0')?.similarity ?? Number.NaN,
      );
      const stopped = firstValueFrom(
        service.changes().pipe(filter((event) => event.kind === 'stopped')),
      );
      service.stop();
      await stopped;
      console.log(`cycle ${cycle}: child stopped`);
    }

    await service.request({ op: 'counts', slot: 'active' }, 30_000);
    const crashed = firstValueFrom(
      service.changes().pipe(filter((event) => event.kind === 'crashed')),
    );
    process.kill(service.pid ?? -1, 'SIGABRT');
    console.log(`crash observed: ${JSON.stringify(await crashed)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const afterCrash = await service.request(
      { op: 'counts', slot: 'active' },
      30_000,
    );
    console.log(`after restart: ${JSON.stringify(afterCrash)}`);

    const reference = await Embedder.load(model);
    const [query] = await reference.embed([QUERY], 'query');
    const [doc] = await reference.embed([DOCS[0] as string], 'document');
    let expected = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expected += (query?.[i] ?? 0) * (doc?.[i] ?? 0);
    }
    await reference.release();
    const drift = Math.max(
      ...scores.map((score) => Math.abs(score - expected)),
    );
    console.log(
      `reference similarity ${expected.toFixed(6)}, worker ${scores.map((s) => s.toFixed(6)).join(' ')}, max drift ${drift.toExponential(2)}`,
    );
    if (!(drift < 1e-4)) {
      throw new Error('the child disagrees with the in-process reference');
    }
  } finally {
    service.closeAll();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
