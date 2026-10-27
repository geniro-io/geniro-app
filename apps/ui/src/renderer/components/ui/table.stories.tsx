import type { Meta, StoryObj } from '@storybook/react-vite';
import * as React from 'react';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

interface VersionRow {
  id: string;
  savedAt: string;
  runs: number;
  cost: string;
}

const VERSIONS: VersionRow[] = [
  { id: 'a1b2c3d4', savedAt: 'Oct 27, 14:02', runs: 18, cost: '$12.40' },
  { id: 'e5f6a7b8', savedAt: 'Oct 25, 09:41', runs: 7, cost: '$4.85' },
  { id: '9c0d1e2f', savedAt: 'Oct 21, 17:30', runs: 0, cost: '—' },
  { id: '3a4b5c6d', savedAt: 'Oct 14, 11:08', runs: 32, cost: '$27.15' },
];

const meta = {
  title: 'Primitives/Table',
  component: Table,
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {
  render: () => (
    <Table className="w-[28rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead>Saved</TableHead>
          <TableHead align="right">Runs</TableHead>
          <TableHead align="right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {VERSIONS.map((version) => (
          <TableRow key={version.id}>
            <TableCell className="font-mono">{version.id}</TableCell>
            <TableCell>{version.savedAt}</TableCell>
            <TableCell align="right">{version.runs}</TableCell>
            <TableCell align="right">{version.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const Interactive: Story = {
  render: () => {
    const Demo = (): React.JSX.Element => {
      const [opened, setOpened] = React.useState<string | undefined>();
      return (
        <div className="flex w-[28rem] flex-col gap-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead align="right">Runs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {VERSIONS.map((version) => (
                <TableRow
                  key={version.id}
                  interactive
                  onClick={() => setOpened(version.id)}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-mono outline-none"
                      onClick={() => setOpened(version.id)}>
                      {version.id}
                    </button>
                  </TableCell>
                  <TableCell>{version.savedAt}</TableCell>
                  <TableCell align="right">{version.runs}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            {opened === undefined ? 'No version opened' : `Opened ${opened}`}
          </p>
        </div>
      );
    };
    return <Demo />;
  },
};

export const WithFooter: Story = {
  render: () => (
    <Table className="w-[28rem]">
      <TableCaption>Versions of Release notes, newest first.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead align="right">Runs</TableHead>
          <TableHead align="right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {VERSIONS.map((version) => (
          <TableRow key={version.id}>
            <TableCell className="font-mono">{version.id}</TableCell>
            <TableCell align="right">{version.runs}</TableCell>
            <TableCell align="right">{version.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell align="right">57</TableCell>
          <TableCell align="right">$44.40</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

const OVERFLOW_COLUMNS = [
  'Version',
  'Saved',
  'Runs',
  'Failed',
  'Turns',
  'Cache read',
  'Own cost',
  'With callees',
];

export const Overflow: Story = {
  render: () => (
    <div className="w-[28rem]">
      <Table containerClassName="max-h-64" className="min-w-[44rem]">
        <TableHeader>
          <TableRow>
            {OVERFLOW_COLUMNS.map((column, index) => (
              <TableHead key={column} align={index < 2 ? 'left' : 'right'}>
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 20 }, (_, index) => {
            const runs = (index * 7) % 23;
            return (
              <TableRow key={index}>
                <TableCell className="font-mono">
                  {(0xa1b2c3d4 + index * 0x1f3a5).toString(16)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  Oct {27 - (index % 27)}, 14:02
                </TableCell>
                <TableCell align="right">{runs}</TableCell>
                <TableCell align="right">{runs % 4}</TableCell>
                <TableCell align="right">{runs * 6}</TableCell>
                <TableCell align="right">{runs * 12}k</TableCell>
                <TableCell align="right">
                  {runs === 0 ? '—' : `$${(runs * 0.69).toFixed(2)}`}
                </TableCell>
                <TableCell align="right">
                  {runs === 0 ? '—' : `$${(runs * 0.83).toFixed(2)}`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  ),
};
