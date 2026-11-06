import { describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { KnowledgeService } from '../../knowledge/services/knowledge.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectsService } from '../../projects/services/projects.service';
import { projectInstructionsText } from '../../projects/utils/project-instructions';
import { InstructionSizesService } from './instruction-sizes.service';
import { ProjectInstructionSizesService } from './project-instruction-sizes.service';

const PROJECT = {
  id: 'p-shop',
  name: 'Shop',
  folder: '/w/shop',
  description: 'The storefront.',
  instructions: 'Ship small pull requests.',
  instructionBlocks: [
    { id: 'b1', title: 'Reviews', text: '  Ship small pull requests.  ' },
  ],
};
const INDEX = 'Memory index (data):\n- m1 [project] Use pnpm (project)';

function subjectWith(memoryIndex: string | null, knowledgeIndex?: string) {
  const projects = { get: vi.fn(async () => PROJECT) };
  const memory = {
    runSnapshot: vi.fn(async () => ({ nativeMemoryOff: false, memoryIndex })),
  };
  const subject = new ProjectInstructionSizesService(
    projects as unknown as ProjectsService,
    memory as unknown as MemoryService,
    {
      runSnapshot: vi.fn(async () => ({
        knowledgeIndex: knowledgeIndex ?? null,
      })),
    } as unknown as KnowledgeService,
    new InstructionSizesService(
      new AgentAdapterRegistry([new ClaudeAdapter()]),
    ),
  );
  return { subject, projects, memory };
}

describe('ProjectInstructionSizesService', () => {
  it('measures the project’s own text and the memory index a run there would read', async () => {
    const { subject, memory } = subjectWith(INDEX);

    const answer = await subject.measure('p-shop', {
      customInstructions: 'MINE',
    });

    expect(memory.runSnapshot).toHaveBeenCalledWith({
      taskId: null,
      cwd: '/w/shop',
      projectId: 'p-shop',
    });
    const parts = new Map(
      answer.agents[0]!.parts.map((part) => [part.source, part.chars]),
    );
    expect(parts.get('projectInstructions')).toBe(
      projectInstructionsText(PROJECT)!.length,
    );
    expect(parts.get('memoryIndex')).toBe(INDEX.length);
    expect(parts.get('customInstructions')).toBe(4);
    expect(answer.blocks).toEqual([
      {
        blockId: 'b1',
        chars: 'Ship small pull requests.'.length,
        approxTokens: expect.any(Number),
        reaches: 1,
      },
    ]);
  });

  it('measures the knowledge index a run there would snapshot', async () => {
    const { subject } = subjectWith(null, 'Knowledge index');

    const answer = await subject.measure('p-shop', {});

    expect(
      answer.agents[0]!.parts.find((part) => part.source === 'knowledgeIndex')
        ?.chars,
    ).toBe('Knowledge index'.length);
  });

  it('leaves the memory index out when a run there would have none', async () => {
    const { subject } = subjectWith(null);

    const answer = await subject.measure('p-shop', {});

    expect(answer.agents[0]!.parts.map((part) => part.source)).not.toContain(
      'memoryIndex',
    );
  });
});
