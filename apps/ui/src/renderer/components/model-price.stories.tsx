import type { Meta, StoryObj } from '@storybook/react-vite';

import { ModelPrice } from './model-price';

const meta = {
  title: 'Components/ModelPrice',
  component: ModelPrice,
  args: {
    price: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, tiers: [] },
  },
} satisfies Meta<typeof ModelPrice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WholeDollars: Story = {};

export const CentsAndCacheRates: Story = {
  args: {
    price: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [],
    },
  },
};

export const WithLongContextTier: Story = {
  args: {
    price: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [
        {
          aboveContextTokens: 272_000,
          input: 4,
          output: 15,
          cacheRead: 0.2,
          cacheWrite: 5,
        },
      ],
    },
  },
};

export const BesideAModel: Story = {
  render: (args) => (
    <div className="flex w-72 items-baseline gap-2 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        claude-opus-5-5
      </span>
      <ModelPrice {...args} />
    </div>
  ),
};

export const CompactOnAnAgentCard: Story = {
  render: (args) => (
    <div className="flex w-64 items-baseline gap-2 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        claude-haiku-5-5
      </span>
      <ModelPrice {...args} compact />
      <span className="shrink-0 tabular-nums text-foreground">$0.01</span>
    </div>
  ),
};

export const Unpriced: Story = { args: { price: null } };
