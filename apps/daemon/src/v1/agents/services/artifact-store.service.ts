import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { mintToken } from '../../../auth/mint-token';
import { safeEqual } from '../../../auth/safe-equal';
import { environment } from '../../../environments';
import { atomicWriteSync } from '../../../utils/atomic-file';
import { registerSecret } from '../../diagnostics/utils/redact';
import {
  ARTIFACT_ID_PATTERN,
  type HostArtifact,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_ID_LENGTH,
  MAX_ARTIFACT_VERSIONS,
} from '../chat.types';

/** Constructor options — test seams, not user config. */
export interface ArtifactStoreOptions {
  /** Artifacts root (test seam); default `<userData>/artifacts`. */
  root?: string;
}

/** What one published artifact is, once it is on disk. */
export interface StoredArtifact {
  artifactId: string;
  version: number;
  key: string;
}

/** A publish either landed, or was refused for a reason the agent can act on. */
export type ArtifactPublishResult =
  { ok: true; stored: StoredArtifact } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What `meta.json` holds beside an artifact's versions. */
interface ArtifactMeta {
  key: string;
  version: number;
}

/**
 * The HTML pages agents publish with `show_artifact`, stored as files under
 * `<userData>/artifacts/<runId>/<artifactId>/`.
 *
 * Files rather than SQLite rows for {@link AttachmentStoreService}'s reason and
 * one of its own. The storage split keeps blobs out of the database; and a page
 * is reached by the renderer as a FRAMED URL, so the bytes have to be something
 * an HTTP route can stream without the row that named it being loaded first.
 *
 * A version is never overwritten, and the newest {@link MAX_ARTIFACT_VERSIONS}
 * are kept: a transcript row names the version it published, so an older row
 * in the scrollback goes on opening the page it actually announced instead of
 * silently showing whatever the agent wrote last. Past that window the page is
 * pruned and the route answers its ordinary 404 — the ceiling exists because
 * republishing is a LOOP an agent is told to run, where every other cap in
 * this family bounds one call.
 *
 * Two shapes are validated before anything is joined into a path, and both are
 * shapes this service or its reader minted: a UUID run id, and an artifact id
 * matching {@link ARTIFACT_ID_PATTERN}. So a `..` segment arriving from a route
 * param or from a model's tool call cannot walk out of the artifacts root.
 */
@Injectable()
export class ArtifactStoreService {
  private readonly root: string;

  constructor(options: ArtifactStoreOptions = {}) {
    this.root = options.root ?? join(environment.userDataDir, 'artifacts');
  }

  /**
   * Write one page and return what the transcript row should carry.
   *
   * The size is measured on the ENCODED bytes, which is the only honest limit:
   * a page of mostly non-ASCII text is up to three times its character count,
   * and the ceiling exists to bound what reaches the disk and the frame.
   *
   * Republishing under an existing id BUMPS the version and KEEPS the key, so
   * every row ever written for this artifact goes on resolving — a rotated key
   * would silently break the open cards above it in the same transcript.
   */
  publish(runId: string, artifact: HostArtifact): ArtifactPublishResult {
    if (!UUID.test(runId)) {
      return {
        ok: false,
        reason: 'the run is not one artifacts can be stored for',
      };
    }
    const bytes = Buffer.from(artifact.html, 'utf8');
    if (bytes.byteLength > MAX_ARTIFACT_HTML_BYTES) {
      const limit = Math.floor(MAX_ARTIFACT_HTML_BYTES / 1024);
      return {
        ok: false,
        reason: `the page is ${Math.floor(bytes.byteLength / 1024)}KB, over the ${limit}KB limit — publish a smaller one`,
      };
    }
    const artifactId = this.resolveId(artifact.id);
    const dir = join(this.root, runId, artifactId);
    mkdirSync(dir, { recursive: true });
    const previous = this.readMeta(dir);
    const meta: ArtifactMeta = {
      key: previous?.key ?? mintToken(),
      version: (previous?.version ?? 0) + 1,
    };
    // Registered at the one place this credential comes into existence, which
    // is the rule `CallTokenRegistry.issue` follows for the same reason: the
    // key rides the item payload, and the debug sink writes a preview of every
    // payload into a log the user is invited to paste into a bug report. A
    // reused key is registered again — idempotent per (value, label) — because
    // the first read after a restart is the only chance this process gets.
    registerSecret(meta.key, 'artifact key');
    writeFileSync(join(dir, `v${meta.version}.html`), bytes);
    // The page lands BEFORE the meta that advertises it: a crash between the
    // two leaves an unreferenced file, where the reverse order would leave a
    // meta pointing at a version that does not exist.
    //
    // ATOMIC, unlike the page beside it: this file is read back to decide the
    // next version and the key, so a half-written one reads as absent, which
    // would mint a fresh key and restart at v1 — orphaning every transcript
    // row of that artifact, since each carries the old key.
    atomicWriteSync(join(dir, 'meta.json'), JSON.stringify(meta));
    this.prune(dir, meta.version);
    return {
      ok: true,
      stored: { artifactId, version: meta.version, key: meta.key },
    };
  }

  /**
   * Drop every version older than the newest {@link MAX_ARTIFACT_VERSIONS}.
   *
   * AFTER the meta write rather than before, so a crash mid-prune leaves the
   * newest version advertised and readable; the next publish removes whatever
   * survived. It reads the directory rather than deleting one computed name
   * for that reason — an earlier prune that did not finish must not leave a
   * file nothing will ever look at again.
   *
   * Best-effort per file: a page that will not delete is disk nobody can see,
   * which is not worth failing a publish the user is waiting on.
   */
  private prune(dir: string, newest: number): void {
    const oldest = newest - MAX_ARTIFACT_VERSIONS;
    if (oldest < 1) {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^v(\d+)\.html$/.exec(name);
      const version = match?.[1] === undefined ? null : Number(match[1]);
      if (version !== null && version <= oldest) {
        rmSync(join(dir, name), { force: true });
      }
    }
  }

  /**
   * One stored page's HTML, or null when the request names nothing this store
   * holds or presents the wrong key.
   *
   * ONE null for every failure, deliberately: the caller is an HTTP route with
   * no session, so distinguishing "no such artifact" from "wrong key" would let
   * an unauthenticated prober enumerate which artifacts a run holds.
   */
  read(
    runId: string,
    artifactId: string,
    version: number,
    key: string,
  ): string | null {
    if (
      !UUID.test(runId) ||
      !ARTIFACT_ID_PATTERN.test(artifactId) ||
      artifactId.length > MAX_ARTIFACT_ID_LENGTH ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      return null;
    }
    const dir = join(this.root, runId, artifactId);
    const meta = this.readMeta(dir);
    if (meta === null || !safeEqual(meta.key, key)) {
      return null;
    }
    try {
      return readFileSync(join(dir, `v${version}.html`), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Delete every artifact of one run, and the run's directory with them.
   *
   * Lives here beside `publish` for {@link AttachmentStoreService.removeRun}'s
   * reason — this service is the only thing that knows the layout. Best-effort
   * and idempotent: a run that never published has no directory, and that is a
   * success rather than an error.
   */
  removeRun(runId: string): void {
    if (!UUID.test(runId)) {
      return;
    }
    rmSync(join(this.root, runId), { recursive: true, force: true });
  }

  /**
   * The id to store under: the agent's own when it named a usable one, else a
   * fresh one nothing can collide with.
   *
   * Re-checked here rather than trusted from the reader, because this is the
   * value that becomes a directory name and the check belongs where the join
   * happens. A minted id is a bare UUID, which already matches the pattern.
   */
  private resolveId(requested: string | undefined): string {
    if (
      requested !== undefined &&
      requested.length <= MAX_ARTIFACT_ID_LENGTH &&
      ARTIFACT_ID_PATTERN.test(requested)
    ) {
      return requested;
    }
    return randomUUID();
  }

  /** The stored meta, or null when there is none or it cannot be read. */
  private readMeta(dir: string): ArtifactMeta | null {
    let raw: string;
    try {
      raw = readFileSync(join(dir, 'meta.json'), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const { key, version } = parsed as Record<string, unknown>;
      if (typeof key !== 'string' || key.length === 0) {
        return null;
      }
      if (!Number.isInteger(version) || (version as number) < 1) {
        return null;
      }
      return { key, version: version as number };
    } catch {
      return null;
    }
  }
}
