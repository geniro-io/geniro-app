import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { TabStrip } from './tab-strip';

type Tab = 'team' | 'memory' | 'stats';

const TABS = [
  { id: 'team', label: 'Team' },
  { id: 'memory', label: 'Memory', count: 12 },
  { id: 'stats', label: 'Statistics' },
] as const;

function Stateful(): React.JSX.Element {
  const [value, setValue] = useState<Tab>('team');
  return (
    <div className="w-[480px] border-b border-border">
      <TabStrip
        tabs={TABS}
        value={value}
        onSelect={setValue}
        label="Team sections"
        idPrefix="story"
      />
    </div>
  );
}

const meta = {
  title: 'Components/TabStrip',
  component: TabStrip,
  args: {
    tabs: TABS,
    value: 'team',
    onSelect: () => {},
    label: 'Team sections',
    idPrefix: 'story',
  },
} satisfies Meta<typeof TabStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <Stateful /> };

export const Narrow: Story = {
  render: () => (
    <div className="w-40 border-b border-border">
      <TabStrip
        tabs={TABS}
        value="stats"
        onSelect={() => {}}
        label="Team sections"
        idPrefix="narrow"
      />
    </div>
  ),
};

function ClosableStateful(): React.JSX.Element {
  const [tabs, setTabs] = useState([
    { id: 'a', label: 'Manifest Law' },
    { id: 'b', label: 'localhost:3560' },
    { id: 'c', label: 'Docs' },
  ]);
  const [value, setValue] = useState('a');
  return (
    <div className="w-[480px] border-b border-border">
      <TabStrip
        tabs={tabs}
        value={value}
        onSelect={setValue}
        onClose={(id) => setTabs((all) => all.filter((tab) => tab.id !== id))}
        label="Browser tabs"
        idPrefix="closable"
      />
    </div>
  );
}

export const Closable: Story = { render: () => <ClosableStateful /> };
