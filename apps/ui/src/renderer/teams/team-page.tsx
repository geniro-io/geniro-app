import { useId } from 'react';

import { BackLink } from '../components/back-link';
import {
  tabId,
  tabPanelId,
  TabStrip,
  type TabStripTab,
} from '../components/tab-strip';

export type TeamTab = 'team' | 'memory' | 'stats';

/** One section of the Team tab: a heading, a one-line hint, its content. */
export function TeamSection({
  title,
  hint,
  action,
  children,
  slot,
}: {
  title: React.ReactNode;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  slot?: string;
}): React.JSX.Element {
  return (
    <section data-slot={slot} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A team's page: a quiet header (back, the chat toggle, the actions), the
 * hero, any banner, then the Team / Memory / Statistics tabs. The page
 * scrolls in its own panel — never the window — and the member sheet and the
 * chat dock sit beside it on the right.
 */
export function TeamPage({
  onBack,
  headerActions,
  hero,
  banner,
  tab,
  onTab,
  memoryCount,
  teamTab,
  memoryTab,
  statsTab,
  sheet,
  dock,
  footer,
}: {
  onBack: () => void;
  headerActions: React.ReactNode;
  hero: React.ReactNode;
  banner?: React.ReactNode;
  tab: TeamTab;
  onTab: (tab: TeamTab) => void;
  /** Team memories; null while not counted. */
  memoryCount: number | null;
  teamTab: React.ReactNode;
  memoryTab: React.ReactNode;
  statsTab: React.ReactNode;
  sheet?: React.ReactNode;
  dock?: React.ReactNode;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const idPrefix = useId();
  const tabs: TabStripTab<TeamTab>[] = [
    { id: 'team', label: 'Team' },
    { id: 'memory', label: 'Memory', count: memoryCount },
    { id: 'stats', label: 'Statistics' },
  ];
  const panel = (id: TeamTab, content: React.ReactNode): React.JSX.Element => (
    <div
      id={tabPanelId(idPrefix, id)}
      role="tabpanel"
      aria-labelledby={tabId(idPrefix, id)}
      hidden={tab !== id}
      className="outline-none">
      {tab === id ? content : null}
    </div>
  );
  return (
    <section data-slot="team-page" className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          data-slot="team-page-scroll"
          className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[880px] flex-col gap-8 px-4 pt-3 pb-16 sm:px-6">
            <div className="flex items-center gap-2">
              <BackLink label="Teams" onClick={onBack} />
              <div className="ml-auto flex items-center gap-1">
                {headerActions}
              </div>
            </div>
            {hero}
            {banner}
            <div className="flex flex-col gap-8">
              <div className="border-b border-border">
                <TabStrip
                  tabs={tabs}
                  value={tab}
                  onSelect={onTab}
                  label="Team sections"
                  idPrefix={idPrefix}
                />
              </div>
              {panel('team', teamTab)}
              {panel('memory', memoryTab)}
              {panel('stats', statsTab)}
            </div>
          </div>
        </div>
        {footer}
      </div>
      {sheet}
      {dock}
    </section>
  );
}
