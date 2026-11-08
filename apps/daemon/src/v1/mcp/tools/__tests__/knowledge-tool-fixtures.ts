import type {
  KnowledgeCallScope,
  KnowledgeDocumentDto,
  KnowledgeHeadDto,
} from '../../../knowledge/knowledge.types';
import type { McpCallContext } from '../../mcp.types';

export const AGENT_SCOPE: KnowledgeCallScope = {
  place: { projectId: 'p1', teamSlug: null },
  actor: {
    kind: 'agent',
    runId: 'run-1',
    memberId: 'senior',
    agentKind: 'claude',
    model: 'opus',
  },
};

export const CALL: McpCallContext = {
  runId: 'run-1',
  memberId: 'senior',
  conversationId: null,
  caller: 'senior',
  requestId: 1,
  remote: false,
  whileCancellable: (call) => call(new AbortController().signal),
};

export function headOf(over: Partial<KnowledgeHeadDto> = {}): KnowledgeHeadDto {
  return {
    id: 'd1',
    handle: 'release-checklist',
    place: 'project:p1',
    projectId: 'p1',
    teamSlug: null,
    title: 'Release checklist',
    whenToRead: 'Cutting a release.',
    bodyBytes: 2048,
    status: 'active',
    rev: 7,
    pending: 0,
    source: { actor: 'user', runId: null, agentKind: null, model: null },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    lastReadAt: null,
    approvedAt: '2026-10-02T00:00:00.000Z',
    ...over,
  };
}

export function documentOf(
  over: Partial<KnowledgeDocumentDto> = {},
): KnowledgeDocumentDto {
  return { ...headOf(), body: 'Tag after CI.', ...over };
}
