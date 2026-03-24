import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tableExists, tableColumns, tableSql } from '../../src/db/utils.js';

describe('db/utils', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'db-utils-test-'));
    db = new Database(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tableColumns throws on invalid table name (SQL injection guard)', () => {
    expect(() => tableColumns(db, 'DROP TABLE foo')).toThrow('Invalid table name');
    expect(() => tableColumns(db, '123bad')).toThrow('Invalid table name');
    expect(() => tableColumns(db, 'table; DROP')).toThrow('Invalid table name');
  });

  it('tableColumns returns columns for a valid table', () => {
    db.exec('CREATE TABLE test_tbl (id INTEGER PRIMARY KEY, name TEXT)');
    const cols = tableColumns(db, 'test_tbl');
    expect(cols).toEqual(['id', 'name']);
  });

  it('tableExists returns false for nonexistent table', () => {
    expect(tableExists(db, 'nonexistent')).toBe(false);
  });

  it('tableExists returns true for existing table', () => {
    db.exec('CREATE TABLE my_table (id INTEGER)');
    expect(tableExists(db, 'my_table')).toBe(true);
  });

  it('tableSql returns null for nonexistent table', () => {
    expect(tableSql(db, 'nonexistent')).toBeNull();
  });

  it('tableSql returns CREATE statement for existing table', () => {
    db.exec('CREATE TABLE my_table (id INTEGER, name TEXT)');
    const sql = tableSql(db, 'my_table');
    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('my_table');
  });
});
