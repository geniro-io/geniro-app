import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type { ThemePreference } from '../../shared/themes';
import { SettingsPanel, SettingsPanelRow } from './settings-panel';
import { ThemePicker } from './theme-picker';

/**
 * Every swatch paints itself in the theme it names, so this story reads the
 * same under either catalog theme — which is the point of it: the Dark swatch
 * is dark inside a light window, and the Light one light inside a dark one.
 * Switch the catalog's theme toolbar and only the surrounding panel moves.
 */
const meta = {
  title: 'Components/ThemePicker',
  component: ThemePicker,
  args: { value: 'system', onSelect: () => undefined },
  render: (args) => {
    const [value, setValue] = useState<ThemePreference>(args.value);
    return <ThemePicker {...args} value={value} onSelect={setValue} />;
  },
} satisfies Meta<typeof ThemePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** A theme pinned rather than deferred to the OS. */
export const ThemePinned: Story = {
  args: { value: 'dark' },
};

/** Where it actually lives — a `block` row of the Settings panel. */
export const InSettings: Story = {
  render: (args) => {
    const [value, setValue] = useState<ThemePreference>(args.value);
    return (
      <div className="w-[42rem] max-w-full">
        <SettingsPanel>
          <SettingsPanelRow
            layout="block"
            label="Theme"
            description="System follows your macOS appearance and changes with it.">
            <ThemePicker {...args} value={value} onSelect={setValue} />
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    );
  },
};
