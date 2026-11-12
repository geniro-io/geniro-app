import type { Meta, StoryObj } from '@storybook/react-vite';

import type {
  BrowserRunState,
  BrowserTabState,
} from '../../../shared/contracts';
import { createPreloadStub } from '../../__fixtures__/preload-stub';
import { BrowserPane } from './browser-pane';

const RUN = 'story-run';

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: 't1',
    url: 'https://staging.acme.dev/login',
    title: 'Sign in · Acme',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    error: null,
    openedBy: null,
    ownCookiesLabel: null,
    drivenBy: null,
    authRequest: null,
    ...overrides,
  };
}

function withState(
  tabs: BrowserTabState[],
  extra: Partial<BrowserRunState> = {},
): (story: () => React.JSX.Element) => React.JSX.Element {
  const state: BrowserRunState = {
    runId: RUN,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    poppedOut: false,
    recent: [],
    ...extra,
  };
  return (story) => {
    window.geniro = createPreloadStub({
      browserState: () => Promise.resolve(state),
    });
    return (
      <div className="h-[520px] w-[440px] border border-border">{story()}</div>
    );
  };
}

const meta = {
  title: 'Chats/BrowserPane',
  component: BrowserPane,
  args: { runId: RUN, visible: true, onClose: () => {} },
} satisfies Meta<typeof BrowserPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = {
  decorators: [
    withState([
      tab(),
      tab({ id: 't2', title: 'Docs', url: 'https://docs.acme.dev/' }),
    ]),
  ],
};

export const AgentDriving: Story = {
  decorators: [
    withState([
      tab({ openedBy: 'Engineer', drivenBy: 'Engineer', loading: true }),
    ]),
  ],
};

export const OwnCookies: Story = {
  decorators: [withState([tab({ ownCookiesLabel: 'anna', openedBy: 'QA' })])],
};

export const NewTab: Story = {
  decorators: [
    withState([tab({ url: '', title: '' })], {
      recent: ['https://staging.acme.dev/login', 'https://docs.acme.dev/'],
    }),
  ],
};

export const CertificateError: Story = {
  decorators: [
    withState([
      tab({
        url: 'https://self-signed.test/',
        error: {
          code: -202,
          description: 'net::ERR_CERT_AUTHORITY_INVALID',
          url: 'https://self-signed.test/',
          certificate: true,
        },
      }),
    ]),
  ],
};

export const SignInPrompt: Story = {
  decorators: [
    withState([
      tab({ authRequest: { host: 'staging.acme.dev', realm: 'Staging' } }),
    ]),
  ],
};

export const PoppedOut: Story = {
  decorators: [withState([tab()], { poppedOut: true })],
};

export const ChatWindow: Story = {
  args: { windowed: true, onClose: undefined },
  decorators: [
    withState(
      [tab(), tab({ id: 't2', title: 'Docs', url: 'https://docs.acme.dev/' })],
      { poppedOut: true },
    ),
  ],
};
