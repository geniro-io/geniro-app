import { Injectable, Logger } from '@nestjs/common';

import type { AgentCacheResetWire } from '../chat.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentMcpService } from './agent-mcp.service';
import { ContextWindowsService } from './context-windows.service';
import { EffortsService } from './efforts.service';
import { ModelParametersService } from './model-parameters.service';
import { ModelVocabularyStore } from './model-vocabulary.store';
import { ModelsService } from './models.service';

/**
 * Throw away everything the app remembers about what the CLIs said.
 *
 * The MANUAL escape hatch beside three automatic ones (`ModelVocabularyStore`'s
 * doc block names them: the CLI's version, a sign-in geniro ran, and
 * serve-then-refresh past an hour). Those cover every cause this app can
 * observe or bound — and the reason a button still has to exist is the case
 * none of them reaches: the user has looked at the screen, believes it is
 * wrong, and would rather pay the handshakes than argue with a cache. ASKED FOR
 * as "на мыши нужно сделать сброс кэша… как дополнительную функцию", so it is a
 * menu-bar row (View → Clear Agent Cache) rather than a setting.
 *
 * It clears BOTH halves of every cache, which is the whole of the correctness
 * argument: the durable file alone would leave this daemon serving its memory
 * for the rest of the TTL, and a user who presses a button and sees the same
 * stale list for ten minutes has been told the button does nothing.
 *
 * What it deliberately does NOT touch is state that is not a cache of an
 * answer: the harvest stores (what a CLI reported on turns that actually ran —
 * unaskable, so clearing costs the `/` list until a turn runs again) and
 * `ContextWindowStore` (a measurement of a window nobody can re-take on
 * demand). Clearing those would degrade the app for a user who asked for the
 * opposite.
 *
 * Every clear is synchronous and none of them asks a CLI anything: this runs on
 * a request that is trying to make the app FORGET, so a reset that spawned
 * seven process groups would be the opposite of what was pressed.
 */
@Injectable()
export class CacheResetService {
  private readonly logger = new Logger(CacheResetService.name);

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly store: ModelVocabularyStore,
    private readonly models: ModelsService,
    private readonly efforts: EffortsService,
    private readonly contextWindows: ContextWindowsService,
    private readonly modelParameters: ModelParametersService,
    private readonly mcp: AgentMcpService,
  ) {}

  clearAll(): AgentCacheResetWire {
    const cleared =
      this.store.clear() +
      this.models.clearCache() +
      this.efforts.clearCache() +
      this.contextWindows.clearCache() +
      this.modelParameters.clearCache() +
      this.mcp.clearCache() +
      // Every adapter, asked rather than named: the one that holds a cache
      // today is cursor's shared handshake, and a second ACP CLI would hold one
      // for the same reason. `.claude/rules/agent-adapters.md` — nothing
      // outside an adapter's directory branches on which CLI it is.
      [...this.adapters.all().values()].reduce(
        (total, adapter) => total + adapter.clearCaches(),
        0,
      );
    this.logger.log(`cleared ${cleared} cached CLI answer(s) on request`);
    return { cleared };
  }
}
