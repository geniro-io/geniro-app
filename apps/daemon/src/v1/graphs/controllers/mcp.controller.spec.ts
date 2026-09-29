import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { McpServerService } from '../services/mcp-server.service';
import { McpController } from './mcp.controller';

function setup(): {
  controller: McpController;
  handlePost: ReturnType<typeof vi.fn>;
  methodNotAllowed: ReturnType<typeof vi.fn>;
} {
  const handlePost = vi.fn(async () => {});
  const methodNotAllowed = vi.fn();
  const controller = new McpController({
    handlePost,
    methodNotAllowed,
  } as unknown as McpServerService);
  return { controller, handlePost, methodNotAllowed };
}

describe('McpController', () => {
  it('POST delegates to McpServerService.handlePost with the route params', async () => {
    const { controller, handlePost } = setup();
    const req = {} as FastifyRequest;
    const reply = {} as FastifyReply;
    await controller.handle('run-1', 'orch', req, reply);
    expect(handlePost).toHaveBeenCalledWith('run-1', 'orch', req, reply);
  });

  it('POST on a CONVERSATION route hands its conversation through as the caller’s', async () => {
    const { controller, handlePost } = setup();
    const req = {} as FastifyRequest;
    const reply = {} as FastifyReply;
    await controller.handleConversation('run-1', 'eng', 'call-3', req, reply);
    expect(handlePost).toHaveBeenCalledWith(
      'run-1',
      'eng',
      req,
      reply,
      'call-3',
    );
  });

  it('GET and DELETE on a conversation route answer 405 too', () => {
    const { controller, methodNotAllowed } = setup();
    const reply = {} as FastifyReply;
    controller.getConversationNotAllowed(reply);
    controller.deleteConversationNotAllowed(reply);
    expect(methodNotAllowed).toHaveBeenCalledTimes(2);
  });

  it('GET and DELETE each keep their OWN 405 handler (a stacked @Get+@Delete method keeps only the last route)', () => {
    const { controller, methodNotAllowed } = setup();
    const reply = {} as FastifyReply;
    controller.getNotAllowed(reply);
    controller.deleteNotAllowed(reply);
    expect(methodNotAllowed).toHaveBeenCalledTimes(2);
    expect(methodNotAllowed).toHaveBeenCalledWith(reply);
  });
});
