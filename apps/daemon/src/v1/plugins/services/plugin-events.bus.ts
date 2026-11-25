import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { PluginsChangedEvent } from '../plugins.types';

/** In-process pub-sub for plugin file writes; the gateway broadcasts each as `plugins_changed`. */
@Injectable()
export class PluginEventBus {
  private readonly changes = new Subject<PluginsChangedEvent>();

  publish(event: PluginsChangedEvent): void {
    this.changes.next(event);
  }

  allChanges(): Observable<PluginsChangedEvent> {
    return this.changes.asObservable();
  }
}
