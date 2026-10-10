import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

@Entity({ tableName: 'chat_search_chunks' })
@Index({ properties: ['modelKey', 'itemId'] })
export class ChatSearchChunk extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  itemId!: string;

  @PrimaryKey({ type: 'string' })
  modelKey!: string;

  @PrimaryKey({ type: 'integer' })
  chunkIndex!: number;

  @Property({ type: 'integer', default: 0 })
  textOffset = 0;

  @Property({ type: 'string' })
  textHash!: string;

  @Property({ type: 'text' })
  vector!: string;
}
