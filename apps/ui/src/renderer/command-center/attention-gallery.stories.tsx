import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  approvalRequest,
  questionRequest,
} from '../__fixtures__/open-requests';
import { AttentionGallery } from './attention-gallery';
import { RequestCard } from './request-card';
import { type AttentionCard, attentionCountsOf } from './use-attention-cards';

const CARDS: AttentionCard[] = [
  {
    key: 'request:q:q-1',
    at: '2026-11-27T08:00:00.000Z',
    kind: 'question',
    request: questionRequest('q', 'q-1', { title: 'Fix the login redirect' }),
  },
  {
    key: 'request:a:a-1',
    at: '2026-11-27T09:00:00.000Z',
    kind: 'approval',
    request: approvalRequest('a', 'a-1', { title: 'Rebase billing on main' }),
  },
];

const meta = {
  title: 'Command center/AttentionGallery',
  component: AttentionGallery,
  args: {
    open: true,
    onClose: () => undefined,
    cards: CARDS,
    counts: attentionCountsOf(CARDS),
    phone: false,
    renderCard: (card) =>
      card.kind === 'question' || card.kind === 'approval' ? (
        <RequestCard request={card.request} onAnswer={() => undefined} />
      ) : null,
  },
} satisfies Meta<typeof AttentionGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two cards; the neighbour peeks at the track's edge. */
export const TwoCards: Story = {};

/** On a phone the gallery fills the screen. */
export const Phone: Story = { args: { phone: true } };

/** Nothing waits on the user. */
export const AllCaughtUp: Story = {
  args: { cards: [], counts: attentionCountsOf([]) },
};
