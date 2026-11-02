import type { Meta, StoryObj } from '@storybook/react-vite';

import { AvatarImageLoaderContext } from './avatar-images';
import { AVATAR_SIZES, AvatarStack, MemberAvatar } from './member-avatar';

const PICTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const loadPicture = async (id: string): Promise<string> => {
  if (id === 'missing.png') {
    throw new Error('not found');
  }
  return PICTURE;
};

const meta = {
  title: 'Components/MemberAvatar',
  component: MemberAvatar,
  args: { name: 'Ada Lovelace', colorKey: 'ada', size: 48 },
  argTypes: {
    size: { control: 'select', options: AVATAR_SIZES },
  },
  decorators: [
    (story) => (
      <AvatarImageLoaderContext.Provider value={loadPicture}>
        {story()}
      </AvatarImageLoaderContext.Provider>
    ),
  ],
} satisfies Meta<typeof MemberAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Initials: Story = {};

export const Emoji: Story = {
  args: { avatar: { kind: 'emoji', value: '🦊', tone: 'avatar-4' } },
};

export const Picture: Story = {
  args: { avatar: { kind: 'picture', value: 'ada.png' } },
};

export const PictureFailsToInitials: Story = {
  args: { avatar: { kind: 'picture', value: 'missing.png' } },
};

export const User: Story = {
  args: { name: 'You', solid: true },
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-end gap-3">
      {AVATAR_SIZES.map((size) => (
        <MemberAvatar key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

export const Stack: Story = {
  render: () => (
    <AvatarStack
      size={40}
      max={5}
      total={7}
      people={[
        { key: 'ada', name: 'Ada' },
        {
          key: 'linus',
          name: 'Linus',
          avatar: { kind: 'emoji', value: '🐧', tone: 'avatar-7' },
        },
        {
          key: 'grace',
          name: 'Grace',
          avatar: { kind: 'picture', value: 'g' },
        },
        { key: 'margaret', name: 'Margaret' },
        { key: 'alan', name: 'Alan' },
      ]}
    />
  ),
};
