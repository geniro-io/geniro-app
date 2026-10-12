import { Injectable } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import type { ItemWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { itemToWire } from '../utils/item-wire';

/** The shared replay boundary for chat, workflow and call-message sends. */
@Injectable()
export class MessageSendService {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly items: ItemDao) {}

  async send(
    runId: string,
    text: string,
    clientMessageId: string | undefined,
    deliver: () => Promise<ItemWire>,
  ): Promise<ItemWire> {
    if (clientMessageId === undefined) {
      return deliver();
    }
    // Reserve synchronously: concurrent retries must not both see no row and
    // deliver before either one's message has been committed.
    const previous = this.pending.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(runId, current);
    await previous;
    try {
      const item = await this.items.userMessageByClientId(
        runId,
        clientMessageId,
      );
      if (item !== null) {
        const wire = itemToWire(item);
        const payload = wire.payload;
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('text' in payload) ||
          payload.text !== text
        ) {
          throw new ConflictException(
            'CLIENT_MESSAGE_ID_CONFLICT',
            'this message id was already used for different text',
          );
        }
        return wire;
      }
      const delivered = await deliver();
      // A row can precede a rejected startup; only successful sends are replayable.
      return itemToWire(
        await this.items.acknowledgeUserMessage(
          runId,
          delivered.id,
          clientMessageId,
        ),
      );
    } finally {
      release();
      if (this.pending.get(runId) === current) {
        this.pending.delete(runId);
      }
    }
  }
}
