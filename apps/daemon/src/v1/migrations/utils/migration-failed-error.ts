import type { MigrationErrorReport } from '../migrations.types';

export class MigrationFailedError extends Error {
  constructor(readonly report: MigrationErrorReport) {
    super(
      report.kind === 'database'
        ? `migration ${report.id} (step ${report.step} of ${report.of}) failed and every database step of this launch was rolled back: ${report.message}`
        : `migration ${report.id} (step ${report.step} of ${report.of}) failed after the database steps were committed; the steps before it stand: ${report.message}`,
    );
    this.name = 'MigrationFailedError';
  }
}
