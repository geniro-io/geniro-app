import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { GENIRO_MCP_SERVER } from '../../agents/utils/tool-metric';
import { UsageCounterDao } from '../dao/usage-counter.dao';
import { CAPABILITY_CATALOG } from '../utils/capability-catalog';

/**
 * What exists in this build, for "never called": Geniro's own MCP tools, which
 * the MCP module hands over at boot, and the capability catalog. A subject not
 * registered by this boot was retired.
 */
@Injectable()
export class UsageRegistryService implements OnModuleInit {
  private readonly logger = new Logger(UsageRegistryService.name);
  readonly bootAt = Date.now();
  private readonly geniroTools = new Set<string>();

  constructor(private readonly dao: UsageCounterDao) {}

  async onModuleInit(): Promise<void> {
    await this.register(
      CAPABILITY_CATALOG.map((subject) => ({
        subjectKind: 'capability' as const,
        subject,
        source: '',
      })),
    );
  }

  /** Geniro's own tools, by the names they are called by. */
  async registerGeniroTools(names: readonly string[]): Promise<void> {
    for (const name of names) {
      this.geniroTools.add(name);
    }
    await this.register(
      [...new Set(names)].map((subject) => ({
        subjectKind: 'tool' as const,
        subject,
        source: GENIRO_MCP_SERVER,
      })),
    );
  }

  isGeniroTool(name: string): boolean {
    return this.geniroTools.has(name);
  }

  private async register(
    subjects: Parameters<UsageCounterDao['registerSubjects']>[0],
  ): Promise<void> {
    try {
      await this.dao.registerSubjects(subjects, this.bootAt);
    } catch (err) {
      this.logger.warn(
        `usage subjects were not registered: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
