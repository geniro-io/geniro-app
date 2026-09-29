import type { Meta, StoryObj } from '@storybook/react-vite';

import { AccountButton } from './account-button';

const noop = (): void => {};

const meta = {
  title: 'Components/AccountButton',
  component: AccountButton,
  args: {
    loggedIn: null,
    signingIn: false,
    onSignIn: noop,
    onSignOut: noop,
  },
} satisfies Meta<typeof AccountButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotKnown: Story = {};

export const SignedIn: Story = {
  args: { loggedIn: true },
};

export const SigningIn: Story = {
  args: { signingIn: true },
};

export const CompactSignedOut: Story = {
  args: { compact: true, loggedIn: false, account: 'work' },
};

export const BusyElsewhere: Story = {
  args: { compact: true, busy: true, account: 'personal' },
};
