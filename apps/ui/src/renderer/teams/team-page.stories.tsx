import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessagesSquare, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { MemberCard } from './member-card';
import { StageJourney } from './stage-journey';
import { TeamHero, UNMEASURED_FIGURES } from './team-hero';
import { TeamMemoryTab, TeamStatsTab } from './team-insights';
import { TeamPage, TeamSection, type TeamTab } from './team-page';

const MEMBERS = [
  {
    id: 'ada',
    name: 'Ada',
    agent: 'claude' as const,
    approval: 'auto' as const,
    role: 'Leads the task and hands work to the others.',
  },
  {
    id: 'linus',
    name: 'Linus',
    agent: 'codex' as const,
    approval: 'auto' as const,
    role: 'Implements the plan in small, tested commits.',
    avatar: { kind: 'emoji' as const, value: '🐧' },
  },
];

function Page(): React.JSX.Element {
  const [tab, setTab] = useState<TeamTab>('team');
  const [query, setQuery] = useState('');
  return (
    <div className="h-[760px] bg-background">
      <TeamPage
        onBack={() => {}}
        headerActions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Change with chat">
              <MessagesSquare />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Team actions">
              <MoreHorizontal />
            </Button>
          </>
        }
        hero={
          <TeamHero
            name="Dev Team"
            description="Plans a change, builds it and reviews it."
            people={MEMBERS.map((member) => ({ key: member.id, ...member }))}
            memberCount={2}
            stageCount={2}
            figures={UNMEASURED_FIGURES}
          />
        }
        tab={tab}
        onTab={setTab}
        memoryCount={null}
        teamTab={
          <div className="flex flex-col gap-10">
            <TeamSection title="Members" hint="Who is on the team.">
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {MEMBERS.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    agentLabel={member.agent}
                    health="unchecked"
                    stageTitles={[]}
                    handlesFirstMessage={member.id === 'ada'}
                    selected={false}
                    onOpen={() => {}}
                  />
                ))}
              </ul>
            </TeamSection>
            <TeamSection title="Stages · 2" hint="The steps every run walks.">
              <StageJourney
                stages={[
                  {
                    id: 'build',
                    title: 'Build',
                    goal: 'Green',
                    responsible: ['linus'],
                    next: ['ship'],
                  },
                  {
                    id: 'ship',
                    title: 'Ship',
                    goal: 'Merged',
                    responsible: ['ada'],
                  },
                ]}
                members={MEMBERS}
                triggerMemberId="ada"
                onPickTrigger={() => {}}
                onOpenStage={() => {}}
                onAddStage={() => {}}
              />
            </TeamSection>
          </div>
        }
        memoryTab={<TeamMemoryTab query={query} onQueryChange={setQuery} />}
        statsTab={<TeamStatsTab runs={null} />}
      />
    </div>
  );
}

const meta = {
  title: 'Teams/TeamPage',
  component: TeamPage,
  args: {
    onBack: () => {},
    headerActions: null,
    hero: null,
    tab: 'team',
    onTab: () => {},
    memoryCount: null,
    teamTab: null,
    memoryTab: null,
    statsTab: null,
  },
} satisfies Meta<typeof TeamPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <Page /> };
