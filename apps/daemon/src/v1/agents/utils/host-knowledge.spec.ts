import { describe, expect, it } from 'vitest';

import { HOST_KNOWLEDGE_TOOLS, HOST_SEARCH_CHATS_TOOL } from '../chat.types';
import { isHostKnowledgeCall } from './host-knowledge';

const SERVER = 'geniro-12345678';
const [SEARCH] = HOST_KNOWLEDGE_TOOLS;

describe('isHostKnowledgeCall', () => {
  it('matches each knowledge tool on geniro’s own server, in both spellings', () => {
    for (const tool of HOST_KNOWLEDGE_TOOLS) {
      expect(isHostKnowledgeCall(SERVER, `mcp__${SERVER}__${tool}`)).toBe(true);
      expect(isHostKnowledgeCall(SERVER, `${SERVER}-${tool}: ${tool}`)).toBe(
        true,
      );
    }
  });

  it('matches no look-alike name, no other tool, no other server and nothing without a server', () => {
    expect(isHostKnowledgeCall(SERVER, `mcp__${SERVER}__${SEARCH}s`)).toBe(
      false,
    );
    expect(isHostKnowledgeCall(SERVER, `mcp__${SERVER}__my_${SEARCH}`)).toBe(
      false,
    );
    expect(isHostKnowledgeCall(SERVER, `${SERVER}-${SEARCH}: ${SEARCH}s`)).toBe(
      false,
    );
    expect(
      isHostKnowledgeCall(SERVER, `mcp__${SERVER}__${HOST_SEARCH_CHATS_TOOL}`),
    ).toBe(false);
    expect(isHostKnowledgeCall(SERVER, `mcp__geniro-87654321__${SEARCH}`)).toBe(
      false,
    );
    expect(isHostKnowledgeCall(null, `mcp__${SERVER}__${SEARCH}`)).toBe(false);
  });
});
