import { describe, expect, it } from 'vitest';

import { freshVocabularyStore } from './__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from './claude/claude.adapter';
import { CodexAdapter } from './codex/codex.adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';

describe('AgentAdapter.modelVendorOf', () => {
  it('names one vendor for every model of a single-vendor CLI, and none for a local model', () => {
    const claude = new ClaudeAdapter();
    const codex = new CodexAdapter();

    expect(claude.modelVendorOf('opus')).toBe('anthropic');
    expect(claude.modelVendorOf(null)).toBe('anthropic');
    expect(claude.modelVendorOf('ollama/qwen3')).toBeNull();
    expect(codex.modelVendorOf('gpt-6.1-sol')).toBe('openai');
  });

  it("reads a multi-vendor CLI's vendor off the model id, and none for an auto pick", () => {
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });

    expect(cursor.modelVendorOf('claude-opus-5-5-high')).toBe('anthropic');
    expect(cursor.modelVendorOf('GPT-5.6-sol-high')).toBe('openai');
    expect(cursor.modelVendorOf('gemini-3.7-flash-high')).toBe('google');
    expect(cursor.modelVendorOf('cursor-grok-4.6-high')).toBe('xai');
    expect(cursor.modelVendorOf('composer-2.5')).toBe('cursor');
    expect(cursor.modelVendorOf('auto')).toBeNull();
    expect(cursor.modelVendorOf(null)).toBeNull();
  });
});
