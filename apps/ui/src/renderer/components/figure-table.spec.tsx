// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FigureTable, type FigureTableSort } from './figure-table';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  name: string;
  calls: number;
}

const ROWS: Row[] = [
  { name: 'Bash', calls: 4 },
  { name: 'Read', calls: 9 },
];

const COLUMNS = [
  { header: 'Tool', sortKey: 'name', cell: (row: Row) => row.name },
  {
    header: 'Calls',
    align: 'end' as const,
    sortKey: 'calls',
    cell: (row: Row) => row.calls,
  },
  { header: 'Note', cell: () => '' },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(sort?: FigureTableSort): void {
  act(() => {
    root.render(
      <FigureTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.name}
        emptyLabel="none"
        ariaLabel="Tools"
        sort={sort}
      />,
    );
  });
}

const header = (text: string): HTMLTableCellElement | undefined =>
  [...container.querySelectorAll('th')].find(
    (cell) => cell.textContent === text,
  );

describe('FigureTable', () => {
  it('draws plain headers when the table is not sortable', () => {
    draw();

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('asks for a column by its key when its header is pressed, and marks the sorted one', () => {
    const onSort = vi.fn();
    draw({ key: 'calls', onSort });

    act(() => {
      header('Tool')?.querySelector('button')?.click();
    });

    expect(onSort).toHaveBeenCalledWith('name');
    expect(header('Calls')?.getAttribute('aria-sort')).toBe('descending');
    expect(header('Tool')?.getAttribute('aria-sort')).toBeNull();
    expect(
      container.querySelectorAll('[data-slot="figure-table-sort"]'),
    ).toHaveLength(2);
  });
});
