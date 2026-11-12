import { type ComponentType, useEffect } from 'react';

import type { BrowserWindowRoute } from '../../../shared/browser-window-route';
import { answerLineFlush } from '../../stats/line-flush';
import { BrowserPane } from './browser-pane';

export function BrowserWindowRoot({
  runId,
  title,
}: BrowserWindowRoute): React.JSX.Element {
  useEffect(() => window.geniro.onFlushLineMeasurements(answerLineFlush), []);

  return (
    <div
      data-slot="browser-window"
      className="h-full bg-background text-foreground">
      <BrowserPane runId={runId} visible windowed chatTitle={title} />
    </div>
  );
}

export function browserWindowApp(route: BrowserWindowRoute): ComponentType {
  return function BrowserWindowApp() {
    return <BrowserWindowRoot {...route} />;
  };
}
