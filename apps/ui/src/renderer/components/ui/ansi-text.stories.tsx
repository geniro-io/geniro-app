import type { Meta, StoryObj } from '@storybook/react-vite';

import { AnsiText } from './ansi-text';

const ESC = String.fromCharCode(27);

/** Shorthand for building a CSI SGR sequence in demo text — `sgr('32')` is a green start. */
function sgr(params: string): string {
  return `${ESC}[${params}m`;
}
const RESET = sgr('0');

const meta = {
  title: 'Primitives/AnsiText',
  component: AnsiText,
  args: {
    text: `${sgr('32')}PASS${RESET} ${sgr('2')}test/foo.spec.ts${RESET} (${sgr('1')}12ms${RESET})`,
  },
} satisfies Meta<typeof AnsiText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Colors: Story = {
  render: () => (
    <div className="flex flex-col gap-1 font-mono text-sm">
      <AnsiText
        text={`${sgr('31')}red${RESET} ${sgr('32')}green${RESET} ${sgr('33')}yellow${RESET} ${sgr('34')}blue${RESET} ${sgr('35')}magenta${RESET} ${sgr('36')}cyan${RESET}`}
      />
      <AnsiText
        text={`${sgr('91')}bright red${RESET} ${sgr('92')}bright green${RESET} ${sgr('93')}bright yellow${RESET} ${sgr('94')}bright blue${RESET}`}
      />
    </div>
  ),
};

export const Styles: Story = {
  render: () => (
    <div className="flex flex-col gap-1 font-mono text-sm">
      <AnsiText
        text={`${sgr('1')}bold${RESET} ${sgr('2')}dim${RESET} ${sgr('3')}italic${RESET} ${sgr('4')}underline${RESET}`}
      />
    </div>
  ),
};

export const CommandOutput: Story = {
  render: () => (
    <pre className="rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
      <AnsiText text={`${sgr('2')}$${RESET} pnpm test:unit`} />
      {'\n'}
      <AnsiText
        text={`${sgr('32')}✓${RESET} ansi.spec.ts ${sgr('2')}(4 tests)${RESET}`}
      />
      {'\n'}
      <AnsiText
        text={`${sgr('31')}✗${RESET} chip.spec.tsx ${sgr('2')}(1 failed)${RESET}`}
      />
      {'\n'}
      <AnsiText
        text={`${sgr('2')}  expected ${RESET}${sgr('33')}true${RESET}${sgr('2')} to be ${RESET}${sgr('33')}false${RESET}`}
      />
    </pre>
  ),
};
