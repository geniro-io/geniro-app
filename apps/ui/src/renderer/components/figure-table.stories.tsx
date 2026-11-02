import type { Meta, StoryObj } from '@storybook/react-vite';

import { FigureTable } from './figure-table';

interface Row {
  name: string;
  calls: number;
  avg: string;
}

const ROWS: Row[] = [
  { name: 'Bash', calls: 412, avg: '1.2s' },
  { name: 'Read', calls: 380, avg: '40ms' },
  { name: 'codegraph_explore', calls: 51, avg: '2.8s' },
];

const meta = {
  title: 'Components/FigureTable',
  component: FigureTable<Row>,
  args: {
    ariaLabel: 'Tools',
    rows: ROWS,
    rowKey: (row: Row) => row.name,
    emptyLabel: 'No tool calls recorded.',
    columns: [
      { header: 'Tool', cell: (row: Row) => row.name },
      { header: 'Calls', align: 'end', cell: (row: Row) => row.calls },
      { header: 'Avg time', align: 'end', cell: (row: Row) => row.avg },
    ],
  },
} satisfies Meta<typeof FigureTable<Row>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Empty: Story = { args: { rows: [] } };
