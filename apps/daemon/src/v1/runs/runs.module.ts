import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { CallContext } from './entity/call-context.entity';
import { Item } from './entity/item.entity';
import { NodeState } from './entity/node-state.entity';
import { Run } from './entity/run.entity';
import { RunGroup } from './entity/run-group.entity';

/**
 * Runs domain — runtime/history rows (`runs` / `items` / `node_state` /
 * `call_context`) plus the sidebar groups runs are filed under (`run_groups`).
 * `registerEntities` makes their repositories injectable here; M2 adds the
 * controllers / services / DAOs that expose and drive them.
 */
@Module({
  imports: [registerEntities([Run, Item, NodeState, CallContext, RunGroup])],
})
export class RunsModule {}
