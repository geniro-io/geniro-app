import { Injectable, Logger } from '@nestjs/common';

import type {
  GalleryDownloadFailure,
  HostGallery,
  HostGalleryImage,
} from '../chat.types';
import { megabytes } from '../utils/artifact-image-policy';
import {
  downloadRemoteImage,
  isRemoteImageUrl,
  MAX_REMOTE_IMAGE_BYTES,
  RemoteImageError,
} from '../utils/remote-image';
import { AttachmentStoreService } from './attachment-store.service';

const DOWNLOAD_CONCURRENCY = 4;

/**
 * The whole call's downloads end by then, under the shortest tool-call
 * deadline a CLI holds a geniro call open for (cursor's 60 s).
 */
export const GALLERY_DOWNLOAD_BUDGET_MS = 45_000;

/** What one run may download in all, so an unattended agent cannot fill the disk. */
export const MAX_GALLERY_RUN_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const OUT_OF_TIME = "the gallery's download time ran out";

/** Constructor options — test seams, not user config. */
export interface GalleryImageOptions {
  download?: typeof downloadRemoteImage;
  budgetMs?: number;
  maxRunBytes?: number;
}

/**
 * Turns the URL entries of a `show_gallery` call into files on this machine,
 * so the row the card reads names only local paths and the renderer stays off
 * the network. Each URL is downloaded once, when the agent calls the tool;
 * the file is stored with the run's attachments and removed with the run.
 */
@Injectable()
export class GalleryImageService {
  private readonly logger = new Logger(GalleryImageService.name);
  private readonly download: typeof downloadRemoteImage;
  private readonly budgetMs: number;
  private readonly maxRunBytes: number;
  /** Bytes each run has downloaded since this daemon started; a number per run, never pruned. */
  private readonly runBytes = new Map<string, number>();

  constructor(
    private readonly attachments: AttachmentStoreService,
    options: GalleryImageOptions = {},
  ) {
    this.download = options.download ?? downloadRemoteImage;
    this.budgetMs = options.budgetMs ?? GALLERY_DOWNLOAD_BUDGET_MS;
    this.maxRunBytes = options.maxRunBytes ?? MAX_GALLERY_RUN_DOWNLOAD_BYTES;
  }

  /**
   * The gallery with every URL entry replaced by its downloaded file, in the
   * call's order. An entry that cannot be downloaded is left out and reported;
   * null when nothing is left to show. `stop` (the client cancelling the call)
   * ends every download still out.
   */
  async localize(
    runId: string,
    gallery: HostGallery,
    stop?: AbortSignal,
  ): Promise<{
    gallery: HostGallery | null;
    failures: GalleryDownloadFailure[];
  }> {
    const budget = AbortSignal.timeout(this.budgetMs);
    const signal =
      stop === undefined ? budget : AbortSignal.any([budget, stop]);
    const resolved = new Array<HostGalleryImage | GalleryDownloadFailure>(
      gallery.images.length,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < gallery.images.length) {
        const index = next;
        next += 1;
        resolved[index] = await this.localizeOne(
          runId,
          gallery.images[index]!,
          signal,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, gallery.images.length) },
        worker,
      ),
    );
    const images = resolved.filter(
      (entry): entry is HostGalleryImage => 'path' in entry,
    );
    const failures = resolved.filter(
      (entry): entry is GalleryDownloadFailure => 'url' in entry,
    );
    return {
      gallery: images.length === 0 ? null : { ...gallery, images },
      failures,
    };
  }

  /** Remove the files {@link localize} downloaded for a gallery that was not drawn. */
  discard(runId: string, gallery: HostGallery): void {
    const paths = gallery.images.flatMap((image) =>
      image.source === undefined ? [] : [image.path],
    );
    try {
      this.attachments.removeDownloaded(runId, paths);
    } catch (error) {
      // Left for the run's teardown, which removes the whole directory.
      this.logger.warn(
        `run ${runId} could not remove an undrawn gallery's downloads: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async localizeOne(
    runId: string,
    image: HostGalleryImage,
    signal: AbortSignal,
  ): Promise<HostGalleryImage | GalleryDownloadFailure> {
    if (!isRemoteImageUrl(image.path)) {
      return image;
    }
    const url = image.path;
    if (signal.aborted) {
      return { url, reason: OUT_OF_TIME };
    }
    const budget = `${megabytes(this.maxRunBytes)}MB`;
    // Only what has landed counts: downloads still in flight are not charged
    // ahead, so the run can end past the budget by what was in flight at once
    // (at most DOWNLOAD_CONCURRENCY pictures) rather than refuse one that fits.
    const left = this.maxRunBytes - (this.runBytes.get(runId) ?? 0);
    if (left <= 0) {
      return {
        url,
        reason: `this chat has already downloaded its ${budget} of gallery images`,
      };
    }
    const maxBytes = Math.min(MAX_REMOTE_IMAGE_BYTES, left);
    try {
      const { mediaType, bytes } = await this.download(url, {
        signal,
        abortReason: OUT_OF_TIME,
        maxBytes,
      });
      const path = this.attachments.saveDownloaded(runId, mediaType, bytes);
      this.runBytes.set(runId, (this.runBytes.get(runId) ?? 0) + bytes.length);
      return { ...image, path, source: url };
    } catch (error) {
      if (error instanceof RemoteImageError) {
        return maxBytes < MAX_REMOTE_IMAGE_BYTES &&
          error.message.startsWith('larger than')
          ? {
              url,
              reason: `larger than what is left of this chat's ${budget} of gallery downloads`,
            }
          : { url, reason: error.message };
      }
      // Kept off the agent's answer: a write failure names a path in the
      // user's profile, and the answer goes to a model off this machine.
      this.logger.error(
        `run ${runId} could not store a downloaded gallery image: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { url, reason: 'the downloaded image could not be stored' };
    }
  }
}
