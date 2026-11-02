import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { AvatarImageLoaderContext } from './avatar-images';
import { AvatarPicker } from './avatar-picker';
import type { AvatarLook } from './member-avatar';

const PICTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function Stateful({
  initial,
  upload,
}: {
  initial?: AvatarLook;
  upload: (base64: string) => Promise<string>;
}): React.JSX.Element {
  const [value, setValue] = useState<AvatarLook | undefined>(initial);
  return (
    <AvatarImageLoaderContext.Provider value={async () => PICTURE}>
      <div className="w-fit rounded-card bg-popover p-4 shadow-panel-lg">
        <AvatarPicker
          name="Ada Lovelace"
          colorKey="ada"
          value={value}
          onChange={setValue}
          upload={upload}
          preparePicture={async () => 'AAAA'}
        />
      </div>
    </AvatarImageLoaderContext.Provider>
  );
}

const meta = {
  title: 'Components/AvatarPicker',
  component: AvatarPicker,
  args: {
    name: 'Ada Lovelace',
    colorKey: 'ada',
    value: undefined,
    onChange: () => {},
    upload: async () => 'stored.png',
  },
} satisfies Meta<typeof AvatarPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Stateful upload={async () => 'stored.png'} />,
};

export const Emoji: Story = {
  render: () => (
    <Stateful
      initial={{ kind: 'emoji', value: '🦉', tone: 'avatar-6' }}
      upload={async () => 'stored.png'}
    />
  ),
};

export const Picture: Story = {
  render: () => (
    <Stateful
      initial={{ kind: 'picture', value: 'stored.png' }}
      upload={async () => 'stored.png'}
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <Stateful
      initial={{ kind: 'picture', value: 'stored.png' }}
      upload={() => new Promise<string>(() => {})}
    />
  ),
};

export const FileError: Story = {
  render: () => (
    <Stateful
      initial={{ kind: 'picture', value: 'stored.png' }}
      upload={async () => {
        throw new Error('That file is not a png, jpeg, gif or webp image.');
      }}
    />
  ),
};
