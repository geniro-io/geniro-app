import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SettingsPanel, SettingsPanelRow } from './settings-panel';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

/**
 * The Settings screen's own rows, with the app's real labels and notes — the
 * component is a container, so a story showing one row with placeholder text
 * would document nothing about the thing it exists for, which is what several
 * settings look like ONE UNDER ANOTHER.
 */
const meta = {
  title: 'Components/SettingsPanel',
  component: SettingsPanelRow,
  args: {
    label: 'Show system notifications',
    // Dummy default satisfying the required-args type — every story below
    // supplies its own children through `render`.
    children: null,
  },
  decorators: [
    (story) => <div className="w-[42rem] max-w-full">{story()}</div>,
  ],
} satisfies Meta<typeof SettingsPanelRow>;

export default meta;
type Story = StoryObj<typeof meta>;

function Toggle({ id }: { id: string }): React.JSX.Element {
  const [on, setOn] = useState(true);
  return <Switch id={id} checked={on} onCheckedChange={setOn} />;
}

/** One setting: the name and what it does on the left, the control on the right. */
export const Playground: Story = {
  render: (args) => (
    <SettingsPanel>
      <SettingsPanelRow
        {...args}
        htmlFor="story-notifications"
        description="Banners when an agent asks something and when a turn ends; clicking one opens that chat. Never for the chat you are watching, or a turn you stopped.">
        <Toggle id="story-notifications" />
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/** Several rows, which is the arrangement the divider and the enclosure are for. */
export const Stacked: Story = {
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow
        label="Show system notifications"
        htmlFor="story-stacked-notifications"
        description="Banners when an agent asks something and when a turn ends.">
        <Toggle id="story-stacked-notifications" />
      </SettingsPanelRow>
      <SettingsPanelRow
        label="Keep intermediate steps collapsed"
        htmlFor="story-stacked-steps"
        description="A turn's tool calls start folded, file edits included.">
        <Toggle id="story-stacked-steps" />
      </SettingsPanelRow>
      <SettingsPanelRow label="Delivery">
        <Button type="button" variant="ghost" size="sm">
          macOS settings
        </Button>
        <Button type="button" variant="outline" size="sm">
          Send a test
        </Button>
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/**
 * `block`, for content that IS the width — the label sits above it and nothing
 * is right-aligned. The row under it is the ordinary `inline` one, so the two
 * layouts can be compared in the arrangement they actually appear in.
 */
export const Block: Story = {
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow layout="block">
        <Textarea
          rows={4}
          placeholder="e.g. Always answer in British English. Prefer small, reviewable diffs."
        />
      </SettingsPanelRow>
      <SettingsPanelRow
        label="Applies to new chats"
        description="Handed to every agent at the start of each new chat or workflow run — one already running keeps what it started with.">
        <Button type="button" variant="ghost" size="sm">
          Remove from existing chats
        </Button>
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/**
 * Under `26rem` of CONTAINER width the inline row stacks rather than let either
 * half give way — a truncated description says nothing, and a control squeezed
 * into a 3rem cell cannot be pressed. This is the panel in a narrow window.
 */
export const Narrow: Story = {
  decorators: [(story) => <div className="w-[22rem]">{story()}</div>],
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow
        label="Show system notifications"
        htmlFor="story-narrow-notifications"
        description="Banners when an agent asks something and when a turn ends.">
        <Toggle id="story-narrow-notifications" />
      </SettingsPanelRow>
      <SettingsPanelRow label="Delivery">
        <Button type="button" variant="outline" size="sm">
          Send a test
        </Button>
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};
