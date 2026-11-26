import { closeSync, readSync } from 'node:fs';

import { Injectable, Logger } from '@nestjs/common';

import {
  MAX_UI_MEDIA_BYTES,
  MAX_UI_MEDIA_PER_CALL,
  type SurfaceMediaData,
  UI_MEDIA_URL_PREFIX,
} from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { type A2uiComponent, A2uiError } from '../utils/a2ui/a2ui-validate';
import {
  type ArtifactFileKind,
  megabytes,
  openArtifactFile,
  sniffImageExtension,
} from '../utils/artifact-image-policy';
import { sniffMediaExtension } from '../utils/artifact-media-policy';
import { localMediaRoots } from '../utils/local-media-roots';
import {
  downloadRemoteFile,
  isRemoteImageUrl,
  MAX_REMOTE_IMAGE_BYTES,
  type RemoteFileKind,
  RemoteImageError,
} from '../utils/remote-image';
import {
  AttachmentStoreService,
  SURFACE_MEDIA_TYPES,
  type SurfaceMediaExtension,
} from './attachment-store.service';
import { RunDownloadBudget } from './run-download-budget.service';

export const SURFACE_DOWNLOAD_BUDGET_MS = 45_000;

type MediaSlot = 'image' | 'video' | 'audio';

const SLOTS: Record<string, Record<string, MediaSlot>> = {
  Image: { url: 'image' },
  Video: { url: 'video', posterUrl: 'image' },
  AudioPlayer: { url: 'audio' },
};

const SLOT_EXTENSIONS: Record<MediaSlot, readonly SurfaceMediaExtension[]> = {
  image: ['png', 'jpg', 'gif', 'webp'],
  video: ['mp4', 'webm', 'ogg'],
  audio: ['mp3', 'm4a', 'mp4', 'wav', 'ogg', 'webm'],
};

const SLOT_WORDING: Record<MediaSlot, string> = {
  image: 'a png, jpeg, gif or webp image',
  video: 'an mp4, webm or ogg video',
  audio: 'an mp3, m4a, mp4, wav, ogg or webm sound',
};

const FILE_KIND: ArtifactFileKind = {
  code: 'MEDIA',
  noun: 'media',
  plural: 'media',
};

function capOf(slot: MediaSlot): number {
  return slot === 'image' ? MAX_REMOTE_IMAGE_BYTES : MAX_UI_MEDIA_BYTES;
}

export function sniffSurfaceMedia(
  bytes: Buffer,
  slot: MediaSlot,
): SurfaceMediaExtension | null {
  const image = sniffImageExtension(bytes);
  const media = image === null ? sniffMediaExtension(bytes) : null;
  const extension = image ?? media;
  return extension !== null &&
    (SLOT_EXTENSIONS[slot] as readonly string[]).includes(extension)
    ? (extension as SurfaceMediaExtension)
    : null;
}

function remoteKind(slot: MediaSlot): RemoteFileKind<SurfaceMediaExtension> {
  return {
    accept: slot === 'image' ? 'image/*' : `${slot}/*`,
    maxBytes: capOf(slot),
    sniff: (bytes) => sniffSurfaceMedia(bytes, slot),
    unknownType: `not ${SLOT_WORDING[slot]}`,
    tooLarge: (size) => `larger than the ${size}MB a card's ${slot} may be`,
  };
}

export interface SurfaceMediaEntry {
  mediaType: string;
  source: string | null;
}

export interface LocalizedComponents {
  components: A2uiComponent[];
  media: Record<string, SurfaceMediaEntry>;
}

export interface SurfaceMediaOptions {
  download?: typeof downloadRemoteFile;
  budgetMs?: number;
}

@Injectable()
export class SurfaceMediaService {
  private readonly logger = new Logger(SurfaceMediaService.name);
  private readonly download: typeof downloadRemoteFile;
  private readonly budgetMs: number;

  constructor(
    private readonly attachments: AttachmentStoreService,
    private readonly runBudget: RunDownloadBudget,
    private readonly runs: RunDao,
    options: SurfaceMediaOptions = {},
  ) {
    this.download = options.download ?? downloadRemoteFile;
    this.budgetMs = options.budgetMs ?? SURFACE_DOWNLOAD_BUDGET_MS;
  }

  /** Every media url of these components replaced by its stored copy; throws an {@link A2uiError} naming the refused url. */
  async localize(
    runId: string,
    entries: readonly { component: A2uiComponent; pointer: string }[],
    stop?: AbortSignal,
  ): Promise<LocalizedComponents> {
    const deadline = AbortSignal.timeout(this.budgetMs);
    const signal =
      stop === undefined ? deadline : AbortSignal.any([deadline, stop]);
    const media: Record<string, SurfaceMediaEntry> = {};
    const bySource = new Map<string, string>();
    const written: string[] = [];
    let roots: string[] | null = null;
    try {
      const components: A2uiComponent[] = [];
      for (const { component, pointer } of entries) {
        const slots = SLOTS[component.component] ?? {};
        let next = component;
        for (const [field, slot] of Object.entries(slots)) {
          const value = component[field];
          if (
            typeof value !== 'string' ||
            value.startsWith(UI_MEDIA_URL_PREFIX)
          ) {
            continue;
          }
          const at = `${pointer}/${field}`;
          const known = bySource.get(`${slot}\u0000${value}`);
          let file = known;
          if (file === undefined) {
            if (bySource.size >= MAX_UI_MEDIA_PER_CALL) {
              throw new A2uiError(
                at,
                `one call stores at most ${MAX_UI_MEDIA_PER_CALL} media files`,
              );
            }
            roots ??= localMediaRoots(
              (await this.runs.getById(runId))?.cwd ?? null,
            );
            const stored = isRemoteImageUrl(value)
              ? await this.fetch(runId, value, slot, at, signal)
              : this.copyLocal(runId, value, slot, at, roots);
            file = stored.file;
            written.push(file);
            bySource.set(`${slot}\u0000${value}`, file);
            media[file] = { mediaType: stored.mediaType, source: value };
          }
          next = { ...next, [field]: `${UI_MEDIA_URL_PREFIX}${file}` };
        }
        components.push(next);
      }
      return { components, media };
    } catch (error) {
      this.discard(runId, written);
      throw error;
    }
  }

  read(runId: string, file: string): SurfaceMediaData {
    const { mediaType, bytes } = this.attachments.readSurfaceMedia(runId, file);
    return { file, mediaType, data: bytes.toString('base64') };
  }

  discard(runId: string, files: readonly string[]): void {
    try {
      this.attachments.removeSurfaceMedia(runId, files);
    } catch (error) {
      this.logger.warn(
        `run ${runId} could not remove a card's undrawn media: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async fetch(
    runId: string,
    url: string,
    slot: MediaSlot,
    at: string,
    signal: AbortSignal,
  ): Promise<{ file: string; mediaType: string }> {
    const left = this.runBudget.left(runId);
    const budget = `${megabytes(this.runBudget.limit)}MB`;
    if (left <= 0) {
      throw new A2uiError(at, `this chat has already downloaded its ${budget}`);
    }
    const cap = capOf(slot);
    const maxBytes = Math.min(cap, left);
    try {
      const { mediaType: extension, bytes } = await this.download(
        url,
        remoteKind(slot),
        {
          signal,
          abortReason: "the card's download time ran out",
          maxBytes,
        },
      );
      const file = this.attachments.saveSurfaceMedia(runId, extension, bytes);
      this.runBudget.charge(runId, bytes.length);
      return { file, mediaType: SURFACE_MEDIA_TYPES[extension] };
    } catch (error) {
      if (error instanceof RemoteImageError) {
        throw new A2uiError(
          at,
          maxBytes < cap && error.message.startsWith('larger than')
            ? `${url}: larger than what is left of this chat's ${budget} of downloads`
            : `${url}: ${error.message}`,
        );
      }
      throw error;
    }
  }

  private copyLocal(
    runId: string,
    path: string,
    slot: MediaSlot,
    at: string,
    roots: readonly string[],
  ): { file: string; mediaType: string } {
    let opened: { fd: number; size: number };
    try {
      opened = openArtifactFile(path, roots, FILE_KIND);
    } catch (error) {
      throw new A2uiError(
        at,
        error instanceof Error ? error.message : `${path} could not be read`,
      );
    }
    try {
      const cap = capOf(slot);
      if (opened.size > cap) {
        throw new A2uiError(
          at,
          `${path} is ${megabytes(opened.size)}MB, over the ${megabytes(cap)}MB a card's ${slot} may be`,
        );
      }
      if (opened.size > this.runBudget.left(runId)) {
        throw new A2uiError(
          at,
          `${path}: larger than what is left of this chat's ${megabytes(this.runBudget.limit)}MB of card media`,
        );
      }
      const bytes = Buffer.alloc(opened.size);
      let read = 0;
      while (read < opened.size) {
        const chunk = readSync(
          opened.fd,
          bytes,
          read,
          opened.size - read,
          read,
        );
        if (chunk === 0) {
          break;
        }
        read += chunk;
      }
      const extension = sniffSurfaceMedia(bytes.subarray(0, read), slot);
      if (extension === null) {
        throw new A2uiError(at, `${path} is not ${SLOT_WORDING[slot]}`);
      }
      const file = this.attachments.saveSurfaceMedia(
        runId,
        extension,
        bytes.subarray(0, read),
      );
      this.runBudget.charge(runId, read);
      return { file, mediaType: SURFACE_MEDIA_TYPES[extension] };
    } finally {
      closeSync(opened.fd);
    }
  }
}
