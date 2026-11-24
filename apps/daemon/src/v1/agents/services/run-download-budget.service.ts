import { Injectable } from '@nestjs/common';

export const MAX_RUN_DOWNLOAD_BYTES = 200 * 1024 * 1024;

@Injectable()
export class RunDownloadBudget {
  private readonly used = new Map<string, number>();

  constructor(readonly limit: number = MAX_RUN_DOWNLOAD_BYTES) {}

  left(runId: string): number {
    return this.limit - (this.used.get(runId) ?? 0);
  }

  charge(runId: string, bytes: number): void {
    this.used.set(runId, (this.used.get(runId) ?? 0) + bytes);
  }
}
