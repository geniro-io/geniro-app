import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { z } from 'zod';

import type { AgentEvent } from '../adapters/adapter.types';

export const OLLAMA_MODEL_PREFIX = 'ollama/';
export const OLLAMA_CLOUD_MODEL_REASON =
  'This Ollama model runs in the cloud, not offline.';
const REQUEST_TIMEOUT_MS = 3_000;

export function ollamaModelName(
  model: string | null | undefined,
): string | null {
  if (!model?.startsWith(OLLAMA_MODEL_PREFIX)) {
    return null;
  }
  const name = model.slice(OLLAMA_MODEL_PREFIX.length);
  if (!name || name.startsWith('-') || /\s|\p{Cc}/u.test(name)) {
    throw new Error('Choose an installed Ollama model.');
  }
  return name;
}

export function ollamaBaseUrl(): string {
  const host = process.env.OLLAMA_HOST?.trim() || '127.0.0.1:11434';
  const url = new URL(host.includes('://') ? host : `http://${host}`);
  if (url.hostname === '0.0.0.0') {
    url.hostname = '127.0.0.1';
  }
  if (url.hostname === '[::]') {
    url.hostname = '[::1]';
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Offline Ollama requires a loopback OLLAMA_HOST (localhost, 127.0.0.1 or ::1).',
    );
  }
  if (!/:\d+\/?$/u.test(host)) {
    url.port = '11434';
  }
  return url.origin;
}

export function ollamaInstalled(): boolean {
  const directories = [
    ...(process.env.PATH?.split(delimiter) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
    '/Applications/Ollama.app/Contents/Resources',
    join(homedir(), 'Applications/Ollama.app/Contents/Resources'),
  ];
  return directories.some((directory) => {
    try {
      accessSync(join(directory, 'ollama'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export async function ollamaRequest(
  baseUrl: string,
  path: string,
  model?: string,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(model === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        }),
  });
  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}.`);
  }
  return response.json();
}

const ModelDetailsSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  remote_host: z.string().optional(),
  remote_model: z.string().optional(),
});

export async function ollamaModelReason(
  name: string,
  baseUrl = ollamaBaseUrl(),
): Promise<string | null> {
  const details = ModelDetailsSchema.parse(
    await ollamaRequest(baseUrl, '/api/show', name),
  );
  if (
    details.remote_host ||
    details.remote_model ||
    /(?:[:-]cloud)$/u.test(name)
  ) {
    return OLLAMA_CLOUD_MODEL_REASON;
  }
  if (!details.capabilities.includes('completion')) {
    return 'This model cannot generate text; it cannot run an agent.';
  }
  return details.capabilities.includes('tools')
    ? null
    : 'This model does not support tool calling.';
}

export async function validateOllamaModel(
  model: string | null | undefined,
): Promise<void> {
  const name = ollamaModelName(model);
  if (name === null) {
    return;
  }
  try {
    const reason = await ollamaModelReason(name);
    if (reason) {
      throw new Error(reason);
    }
  } catch (error) {
    throw new Error(
      `Cannot use Ollama model ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function qualifyOllamaEvent(
  event: AgentEvent,
  model: string | null | undefined,
): AgentEvent {
  if (!model?.startsWith(OLLAMA_MODEL_PREFIX)) {
    return event;
  }
  if (event.type === 'turn_model') {
    return { ...event, model };
  }
  if (event.type === 'context_progress') {
    return { ...event, contextModel: model };
  }
  if (event.type === 'cost_progress') {
    return { ...event, costUsd: 0 };
  }
  if (event.type === 'turn_complete' && event.usage) {
    return {
      ...event,
      usage: { ...event.usage, contextModel: model, costUsd: 0 },
    };
  }
  return event;
}
