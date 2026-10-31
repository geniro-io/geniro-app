import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import { vacuumDatabase } from './vacuum-database';

describe('vacuumDatabase', () => {
  it('gives the free pages of a WAL database back to the disk', async () => {
    const file = join(tempDir('vacuum-'), 'geniro.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = wal');
    db.exec('CREATE TABLE items (payload TEXT)');
    const insert = db.prepare('INSERT INTO items (payload) VALUES (?)');
    for (let i = 0; i < 400; i += 1) {
      insert.run('x'.repeat(10_000));
    }
    db.exec('DELETE FROM items');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = statSync(file).size;

    await vacuumDatabase(file);

    expect(statSync(file).size).toBeLessThan(before / 10);
    expect(db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it('keeps the rowids the full-text indexes key a text-keyed table by', async () => {
    const file = join(tempDir('vacuum-'), 'geniro.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = wal');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, payload TEXT)');
    const insert = db.prepare('INSERT INTO items (id, payload) VALUES (?, ?)');
    for (let i = 0; i < 300; i += 1) {
      insert.run(`item-${i}`, 'x'.repeat(5_000));
    }
    db.exec('DELETE FROM items WHERE CAST(substr(id, 6) AS INTEGER) % 3 = 0');
    const read = (): unknown =>
      db.prepare('SELECT rowid AS r, id FROM items ORDER BY id').all();
    const before = read();

    await vacuumDatabase(file);

    expect(read()).toEqual(before);
    db.close();
  });

  it('rejects when the database cannot be compacted', async () => {
    await expect(
      vacuumDatabase(join(tempDir('vacuum-'), 'missing', 'geniro.db')),
    ).rejects.toThrow(/directory does not exist/);
  });
});
