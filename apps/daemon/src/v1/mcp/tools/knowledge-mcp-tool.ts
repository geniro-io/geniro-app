import { randomBytes } from 'node:crypto';

import { redactSecrets } from '../../diagnostics/utils/redact';
import type {
  KnowledgeCallScope,
  KnowledgeHit,
} from '../../knowledge/knowledge.types';
import type { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { kilobytes } from '../../knowledge/utils/knowledge-text';
import type { McpCallContext, McpToolResult } from '../mcp.types';
import { BaseMcpTool } from './base-mcp-tool';

/**
 * The base of the knowledge store's tools (`knowledge_search`,
 * `knowledge_read`, `knowledge_save`): offered while the user has knowledge
 * on, and refused at call time once it is off — a kept CLI keeps its tool
 * list. The run's place and the caller's identity are looked up here, never
 * taken from the arguments.
 */
export abstract class KnowledgeMcpTool extends BaseMcpTool {
  constructor(protected readonly knowledge: KnowledgeService) {
    super();
  }

  protected isOffered(): boolean {
    return this.knowledge.enabled;
  }

  /** Answer a call once knowledge is known to be on and the scope resolved. */
  protected abstract answer(
    args: Record<string, unknown>,
    scope: KnowledgeCallScope,
  ): Promise<McpToolResult>;

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    if (!this.knowledge.enabled) {
      return this.text(
        'KNOWLEDGE_DISABLED: the user has turned knowledge off; work without it.',
        true,
      );
    }
    return this.answer(args, await this.knowledge.callScope(runId, memberId));
  }

  /** Every result, refusals included, is masked of the secrets geniro knows. */
  protected masked(text: string, isError = false): McpToolResult {
    return this.text(redactSecrets(text), isError);
  }
}

/** A fence name no stored body can print: agent text must not forge the page around it. */
export function knowledgeFence(): string {
  return `knowledge-document-${randomBytes(6).toString('hex')}`;
}

/**
 * One line naming a document: handle, revision, level, size, title and when to
 * read it.
 *
 * TWIN PARSER: `knowledgeToolDocsOf` in `apps/ui/src/renderer/chats/knowledge-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function knowledgeHitLine(
  hit: Pick<
    KnowledgeHit,
    | 'handle'
    | 'rev'
    | 'level'
    | 'bodyBytes'
    | 'title'
    | 'whenToRead'
    | 'reviewed'
  >,
): string {
  const size = kilobytes(hit.bodyBytes);
  const reviewed = hit.reviewed ? '' : ', unreviewed';
  return `- ${hit.handle} (rev ${hit.rev}, ${hit.level}, ${size}${reviewed}) — ${hit.title}. When: ${hit.whenToRead}`;
}
