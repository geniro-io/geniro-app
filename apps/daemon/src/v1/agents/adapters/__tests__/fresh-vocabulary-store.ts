import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelVocabularyStore } from '../../services/model-vocabulary.store';

/**
 * A durable model-vocabulary store nobody else can see — one per adapter under
 * test.
 *
 * `CursorAcpAdapter` takes the store as a REQUIRED option, and this is what
 * that requirement is for. It began as an optional field defaulting to a store
 * over `<userData>/model-vocabularies.json`, which under `NODE_ENV=test`
 * resolves to the developer's own `~/.geniro` — so every adapter in every spec
 * shared one file, one case's cached handshake answered another's, and two
 * probe-count assertions failed with "expected 0 to be 1". A store is a CACHE:
 * sharing one across tests is sharing state across tests.
 *
 * The directory is made ONCE PER PROCESS and the files are numbered inside it,
 * which the first version of this got wrong in a way worth recording: numbering
 * straight into `tmpdir()` restarts the counter every run, so store #3 of this
 * run opened the file store #3 of the LAST run had written — and a probe-count
 * assertion passed on a clean machine and failed on the second run. A cache
 * keyed by a name that repeats is a cache shared with the past.
 *
 * A file is never created unless a case actually stores something, so this
 * costs nothing for the specs that only need the argument to exist.
 */
export function freshVocabularyStore(): ModelVocabularyStore {
  storeSeq += 1;
  return new ModelVocabularyStore({
    file: join(storeDir, `${storeSeq}.json`),
  });
}

const storeDir = mkdtempSync(join(tmpdir(), 'geniro-spec-vocabularies-'));
let storeSeq = 0;
