import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SettingRow } from './setting-row';
import type { MenuGroup } from './ui/menu';
import { Select } from './ui/select';

/**
 * A PICKER, because that is what every real row of this component holds —
 * `run-config-picker.tsx` and the graph node inspector between them pass
 * `BranchValueSelect`, `ConfigDirSelect`, `ModelSelect`, `EffortSelect`,
 * `ContextWindowSelect` and `ModelParameterSelect`, and nothing else.
 *
 * This story used to pair the row with a `Switch` under the label "Cursor Max
 * Mode", and both halves were wrong: the app's toggles are `AgentSetting`
 * rows in `agent-config-list.tsx`, a different component with a different
 * shape, and no real label here is long enough to wrap the 7rem column — they
 * are `Agent`, `Folder`, `Branch`, `Profile`, `Model`, `Effort`. The catalog
 * was documenting a composition the app does not contain, and it read as badly
 * as it was.
 */
const MODELS: MenuGroup[] = [
  {
    items: [
      { value: 'opus-5', label: 'claude-opus-5' },
      { value: 'sonnet-5', label: 'claude-sonnet-5' },
      { value: 'haiku-4-5', label: 'claude-haiku-4.5' },
    ],
  },
];

function ModelPicker({ label }: { label: string }): React.JSX.Element {
  const [value, setValue] = useState('opus-5');
  return (
    <Select
      aria-label={label}
      variant="ghost"
      groups={MODELS}
      value={value}
      onValueChange={setValue}
    />
  );
}

const meta = {
  title: 'Components/SettingRow',
  component: SettingRow,
  args: {
    label: 'Model',
    // Dummy default satisfying the required-args type — every story below
    // supplies its own `children` through `render`.
    children: null,
  },
  render: (args) => (
    <div className="w-96 rounded-lg border border-border bg-card">
      <SettingRow {...args}>
        <ModelPicker label={args.label} />
      </SettingRow>
    </div>
  ),
} satisfies Meta<typeof SettingRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * The one real `hint` in the app, verbatim from `run-config-picker.tsx` — it
 * says what pressing this DOES, which is the rule the prop's own doc states.
 */
export const WithHint: Story = {
  args: {
    label: 'Branch',
    hint: 'Switched before the chat starts; refused over a dirty tree, and the rest still applies.',
  },
};

/** Several rows, which is how the component is always actually seen. */
export const Stacked: Story = {
  render: (args) => (
    <div className="w-96 rounded-lg border border-border bg-card">
      <SettingRow {...args} label="Agent">
        <ModelPicker label="Agent" />
      </SettingRow>
      <SettingRow {...args} label="Model">
        <ModelPicker label="Model" />
      </SettingRow>
      <SettingRow {...args} label="Context window">
        <ModelPicker label="Context window" />
      </SettingRow>
    </div>
  ),
};

/** The builder inspector's variant, with room for its two columns. */
export const Compact: Story = {
  args: { width: 'compact' },
  render: (args) => (
    <div className="@container w-80 rounded-lg border border-border bg-card">
      <SettingRow {...args}>
        <ModelPicker label={args.label} />
      </SettingRow>
    </div>
  ),
};

/**
 * The same variant under `17rem` of container width, where it STACKS rather
 * than let the value truncate — the panel can be dragged to 240px, and a
 * column of ellipses is the worse answer. Pinned by the component's own
 * container query, so this story is what makes that threshold visible.
 */
export const CompactStacked: Story = {
  args: { width: 'compact' },
  render: (args) => (
    <div className="@container w-56 rounded-lg border border-border bg-card">
      <SettingRow {...args}>
        <ModelPicker label={args.label} />
      </SettingRow>
    </div>
  ),
};
