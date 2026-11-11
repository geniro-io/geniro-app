import { Injectable } from '@nestjs/common';

interface RunApprovals {
  hosts: Set<string>;
  all: boolean;
}

/** What the user let each chat's agents open in the in-app browser, in memory only. */
@Injectable()
export class BrowserHostApprovals {
  private readonly byRun = new Map<string, RunApprovals>();

  allows(runId: string, host: string): boolean {
    return this.byRun.get(runId)?.hosts.has(host.toLowerCase()) ?? false;
  }

  allowsAll(runId: string): boolean {
    return this.byRun.get(runId)?.all ?? false;
  }

  approve(runId: string, host: string): void {
    this.entry(runId).hosts.add(host.toLowerCase());
  }

  approveAll(runId: string): void {
    this.entry(runId).all = true;
  }

  hosts(runId: string): string[] {
    return [...(this.byRun.get(runId)?.hosts ?? [])];
  }

  forget(runId: string): void {
    this.byRun.delete(runId);
  }

  private entry(runId: string): RunApprovals {
    let entry = this.byRun.get(runId);
    if (!entry) {
      entry = { hosts: new Set(), all: false };
      this.byRun.set(runId, entry);
    }
    return entry;
  }
}
