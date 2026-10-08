import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { AgentModelWire } from '../chat.types';
import {
  OLLAMA_CLOUD_MODEL_REASON,
  OLLAMA_MODEL_PREFIX,
  ollamaBaseUrl,
  ollamaInstalled,
  ollamaModelReason,
  ollamaRequest,
} from '../utils/ollama';

const TagsSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
});

@Injectable()
export class OllamaService {
  private cached: { url: string; at: number; models: AgentModelWire[] } | null =
    null;
  private pending: { url: string; result: Promise<AgentModelWire[]> } | null =
    null;

  async list(): Promise<AgentModelWire[]> {
    let url: string;
    try {
      url = ollamaBaseUrl();
    } catch (error) {
      return this.unavailable(
        'Ollama configuration',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.cached?.url === url && Date.now() - this.cached.at < 5_000) {
      return this.cached.models;
    }
    if (this.pending?.url === url) {
      return this.pending.result;
    }
    const result = this.discover(url);
    this.pending = { url, result };
    try {
      const models = await result;
      this.cached = { url, at: Date.now(), models };
      return models;
    } finally {
      if (this.pending?.result === result) {
        this.pending = null;
      }
    }
  }

  private async discover(url: string): Promise<AgentModelWire[]> {
    try {
      const { models } = TagsSchema.parse(
        await ollamaRequest(url, '/api/tags'),
      );
      const local: AgentModelWire[] = [];
      for (let start = 0; start < models.length; start += 4) {
        const batch = await Promise.all(
          models.slice(start, start + 4).map(async ({ name }) => {
            try {
              const reason = await ollamaModelReason(name, url);
              if (reason === OLLAMA_CLOUD_MODEL_REASON) {
                return null;
              }
              return {
                id: `${OLLAMA_MODEL_PREFIX}${name}`,
                label: name,
                source: 'ollama' as const,
                ...(reason ? { unavailableReason: reason } : {}),
              };
            } catch {
              return {
                id: `${OLLAMA_MODEL_PREFIX}${name}`,
                label: name,
                source: 'ollama' as const,
                unavailableReason:
                  'Could not read model details. Check Ollama and refresh.',
              };
            }
          }),
        );
        for (const model of batch) {
          if (model) {
            local.push(model);
          }
        }
      }
      return local.length
        ? local
        : this.unavailable(
            'No local models',
            'Ollama is running. Download a tool-capable model with ollama pull <model>.',
          );
    } catch {
      return ollamaInstalled()
        ? this.unavailable(
            'Ollama is stopped',
            `Start the Ollama app or run ollama serve. Expected ${url}.`,
          )
        : this.unavailable(
            'Ollama is not installed',
            'Install Ollama, start it, and download a local model.',
          );
    }
  }

  private unavailable(
    label: string,
    unavailableReason: string,
  ): AgentModelWire[] {
    return [
      { id: OLLAMA_MODEL_PREFIX, label, source: 'ollama', unavailableReason },
    ];
  }
}
