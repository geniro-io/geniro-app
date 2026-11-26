---
description: Search by meaning — the embedding child, embeddings.db and the fused searches
paths:
  - "apps/daemon/src/v1/embeddings/**"
---

# Daemon — search by meaning

`v1/embeddings` turns on-device meaning search on for memory, knowledge and chat search. Electron main downloads the model (`apps/ui/src/main/search-model/`) and pushes `PUT /v1/embeddings/config`; the daemon holds that config in memory only.

## The embedding child

- onnxruntime-node and the sqlite-vec extension load ONLY in the child (`worker/embedding-worker.ts`), never in the daemon process: a native crash in onnxruntime ends only the child.
- `EmbeddingProcessService` owns the one child like `AgentSessionRegistry` owns kept CLI processes: spawned detached with `buildChildEnv({ ELECTRON_RUN_AS_NODE: '1' })`, journaled with `trackDetachedChild`, closed by its own shutdown hook and by the pidfile and instance-lock hooks. It is NOT in `ProcessRegistry`, whose `activeCount` would block the idle exit and database compaction.
- The session options `enableCpuMemArena: false` and `enableMemPattern: false` and inputs of at most `EMBEDDING_MAX_TOKENS` tokens keep onnxruntime away from the allocations that crash it under Electron's Node. Do not move `onnxruntime-node` past 1.30.0 without re-measuring that.
- After `EMBEDDING_IDLE_UNLOAD_MS` with no request the child is stopped; a crash is restarted after `EMBEDDING_RESTART_DELAYS_MS`, then left down until the next config push.

## embeddings.db

- `<userData>/embeddings.db` is opened by the child through `node:sqlite` (the driver the extension was measured with), never through the MikroORM connection, never listed in `skipTables`, and no vector ever goes into `geniro.db`.
- Every vector carries its model's `<id>@<revision>`; rows of another model are never compared.
- Deletions the daemon cannot hand to a running child go into the file's `deletions` table through a plain `node:sqlite` connection; the child drains it on open.
- `vec0` rowids are bound as `BigInt`: `node:sqlite` binds a JS number as REAL, which vec0 refuses as a key.

## Searches

- Every meaning query answers null when meaning search is off, has no model, the child is down or the answer misses `EMBEDDING_QUERY_TIMEOUT_MS`; the caller then returns exactly its word-search result.
- Memory, knowledge and chats fuse their word lists with the meaning list by reciprocal rank fusion (`utils/rrf.ts`). The output line format of `memory_search` and `knowledge_search` and the JSON keys of `search_chats` never change.
- Feature modules register what is embedded (`registerDocuments`, `registerChats`); this module imports none of them.
- Chats embed only user and assistant messages of at least `EMBEDDING_CHAT_MIN_CHARS` characters (`ChatSearchIndexDao.embeddable`), and a chat meaning hit needs `EMBEDDING_CHAT_MIN_SIMILARITY`, stricter than memory and knowledge (`EMBEDDING_MIN_SIMILARITY`): short replies matched nearly any query. `meaningHitsAmong` applies the same length rule, so a vector an older index kept for a short message is never returned.
- The pushed config also names which sources are embedded (`sources`) and how many days back chats go (`chatWindowDays`, null all time). A source switched off is never backfilled, enqueued, polled or scored (its meaning query answers null, so the caller keeps its word result), and `purgeExcluded` — run by the next work after a push and after the daily sweep, once the stored counts are read — drops its vectors (`dropSource`; for chats, their walk cursors too). With a window, the chat walk embeds only messages created inside it, the back walk stops at the first page of `EMBEDDING_CHAT_STEP_ITEMS` messages that holds none inside it (`created_at` is the row's insert time — the `TimestampsEntity` default, which `persistItemAndEmit`, the only insert, never overrides — so it rises with the rowid and the walk loses nothing unless the system clock is set back by more than the window's width), and `deleteChatsBefore` drops older vectors, again every day as messages age out. The window the index was last trimmed to is kept in the file's `meta` (`chat_window_days`), so a wider window after a restart still walks the chats again from the newest; a push is not compared with the previous push. `meaningNote` is the one sentence a search adds while search by meaning is on but leaves part of a source to words: `memory_search` and `knowledge_search` end with it, `search_chats` and the app's chat search put it in `partialReason`, and the Knowledge page's search shows it (`KnowledgeList.meaningNote`).
- A stored chat message calls `EmbeddingIndexService.chatAdded`, which, while chats wait for power, broadcasts `embeddings_changed` so an open Search page shows the pause.
- `status()` counts the totals at most once per `EMBEDDING_TOTALS_FRESH_MS`, and status reads that arrive during a count share it. The chat total is counted in `EMBEDDING_CHAT_COUNT_WINDOW` windows of `items` rowids with a turn for the event loop between them (`ChatEmbeddingSourceService`): one statement over the whole history held the daemon for seconds.
