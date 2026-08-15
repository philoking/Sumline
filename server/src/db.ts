import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Sheet {
  id: string;
  title: string;
  content: string;
  version: number;
  folderId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: string;
  name: string;
  position: number;
}

export type SheetSummary = Omit<Sheet, 'content'> & { lines: number };

/** Names an untitled sheet from its first meaningful line. */
export function deriveTitle(current: string, content: string): string {
  if (current && current !== 'Untitled') return current;
  const first = content
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);
  return first ? first.slice(0, 60) : 'Untitled';
}

export interface Lock {
  sheetId: string;
  clientId: string;
  clientName: string | null;
  expiresAt: number;
}

interface SheetRow {
  id: string;
  title: string;
  content: string;
  version: number;
  folder_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LockRow {
  sheet_id: string;
  client_id: string;
  client_name: string | null;
  expires_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sheets (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  sheet_id    TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  client_name TEXT,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rates (
  base       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  country    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sheets_updated_at ON sheets (updated_at DESC);
`;

/** Raised when a write is based on a version that is no longer current. */
export class VersionConflictError extends Error {
  constructor(readonly current: Sheet) {
    super('Sheet was modified by someone else');
    this.name = 'VersionConflictError';
  }
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Adds columns introduced after the first release.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
   * so a deployed database would otherwise never gain these. Each is checked
   * individually and added only when missing, which makes this safe to run on
   * every start.
   */
  private migrate(): void {
    this.addColumn('sheets', 'folder_id', 'TEXT');
    this.addColumn('sheets', 'deleted_at', 'TEXT');
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Lists sheets, optionally filtered.
   *
   * Search matches title and body with LIKE rather than a full-text index: a
   * personal instance holds tens or hundreds of sheets, where the difference
   * is unmeasurable and the schema cost of FTS is not worth paying.
   */
  listSheets(
    filter: { folderId?: string | null; query?: string; trashed?: boolean } = {},
  ): SheetSummary[] {
    const where: string[] = [
      filter.trashed ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    const params: unknown[] = [];

    if (filter.folderId !== undefined) {
      if (filter.folderId === null) {
        where.push('folder_id IS NULL');
      } else {
        where.push('folder_id = ?');
        params.push(filter.folderId);
      }
    }
    if (filter.query?.trim()) {
      where.push('(title LIKE ? OR content LIKE ?)');
      const pattern = `%${filter.query.trim()}%`;
      params.push(pattern, pattern);
    }

    // The line count is derived in SQL so the list endpoint never has to ship
    // sheet bodies just to say how long they are.
    const rows = this.db
      .prepare(
        `SELECT id, title, version, folder_id, deleted_at, created_at, updated_at,
                CASE WHEN content = '' THEN 0
                     ELSE length(content) - length(replace(content, char(10), '')) + 1
                END AS lines
         FROM sheets WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
      )
      .all(...(params as never[])) as unknown as Array<
      Omit<SheetRow, 'content'> & { lines: number }
    >;
    return rows.map(toSummary);
  }

  getSheet(id: string): Sheet | null {
    const row = this.db
      .prepare('SELECT * FROM sheets WHERE id = ?')
      .get(id) as unknown as SheetRow | undefined;
    return row ? toSheet(row) : null;
  }

  createSheet(title: string, content = '', folderId: string | null = null): Sheet {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sheets (id, title, content, version, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, title, content, folderId, now, now);
    return {
      id,
      title,
      content,
      version: 1,
      folderId,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Writes a sheet, refusing the update if `expectedVersion` is stale.
   *
   * This is the guarantee under the advisory lock: a tab left open overnight
   * cannot silently overwrite work done elsewhere, whatever the lock says.
   */
  updateSheet(
    id: string,
    changes: { title?: string; content?: string; folderId?: string | null },
    expectedVersion?: number,
  ): Sheet {
    const current = this.getSheet(id);
    if (!current) throw new Error('Sheet not found');

    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new VersionConflictError(current);
    }

    const content = changes.content ?? current.content;
    const next: Sheet = {
      ...current,
      // An untitled sheet names itself from its first line, so a new sheet
      // does not have to be named before it can be found again.
      title: changes.title ?? deriveTitle(current.title, content),
      content,
      folderId: changes.folderId === undefined ? current.folderId : changes.folderId,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE sheets SET title = ?, content = ?, folder_id = ?, version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.title, next.content, next.folderId, next.version, next.updatedAt, id);

    return next;
  }

  /** Moves a sheet to the trash, where it can still be restored. */
  trashSheet(id: string): boolean {
    const result = this.db
      .prepare('UPDATE sheets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(new Date().toISOString(), id);
    this.db.prepare('DELETE FROM locks WHERE sheet_id = ?').run(id);
    return result.changes > 0;
  }

  restoreSheet(id: string): boolean {
    const result = this.db
      .prepare('UPDATE sheets SET deleted_at = NULL WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /** Permanently removes everything in the trash. */
  emptyTrash(): number {
    const result = this.db.prepare('DELETE FROM sheets WHERE deleted_at IS NOT NULL').run();
    return Number(result.changes);
  }

  listFolders(): Folder[] {
    return this.db
      .prepare('SELECT id, name, position FROM folders ORDER BY position, name')
      .all() as unknown as Folder[];
  }

  createFolder(name: string): Folder {
    const id = randomUUID();
    const position = this.listFolders().length;
    this.db
      .prepare('INSERT INTO folders (id, name, position) VALUES (?, ?, ?)')
      .run(id, name, position);
    return { id, name, position };
  }

  renameFolder(id: string, name: string): boolean {
    return this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }

  /** Deletes a folder; its sheets return to the top level rather than vanishing. */
  deleteFolder(id: string): boolean {
    this.db.prepare('UPDATE sheets SET folder_id = NULL WHERE folder_id = ?').run(id);
    return this.db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes > 0;
  }

  getSettings(): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all() as unknown as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  }

  saveSettings(values: Record<string, unknown>): Record<string, unknown> {
    const statement = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(values)) {
      statement.run(key, JSON.stringify(value));
    }
    return this.getSettings();
  }

  deleteSheet(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sheets WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM locks WHERE sheet_id = ?').run(id);
    return result.changes > 0;
  }

  getLock(sheetId: string, now = Date.now()): Lock | null {
    const row = this.db
      .prepare('SELECT * FROM locks WHERE sheet_id = ?')
      .get(sheetId) as unknown as LockRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.releaseLock(sheetId, row.client_id);
      return null;
    }
    return {
      sheetId: row.sheet_id,
      clientId: row.client_id,
      clientName: row.client_name,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Grants or refreshes the editing lock.
   *
   * The current holder always wins a renewal; anyone else needs the lock to
   * have expired, or `force` — which is the "take over editing" button.
   */
  acquireLock(
    sheetId: string,
    clientId: string,
    clientName: string | null,
    ttlMs: number,
    force = false,
    now = Date.now(),
  ): { granted: boolean; lock: Lock } {
    const existing = this.getLock(sheetId, now);
    if (existing && existing.clientId !== clientId && !force) {
      return { granted: false, lock: existing };
    }

    const lock: Lock = {
      sheetId,
      clientId,
      clientName,
      expiresAt: now + ttlMs,
    };
    this.db
      .prepare(
        `INSERT INTO locks (sheet_id, client_id, client_name, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sheet_id) DO UPDATE SET client_id = excluded.client_id,
           client_name = excluded.client_name, expires_at = excluded.expires_at`,
      )
      .run(sheetId, clientId, clientName, lock.expiresAt);
    return { granted: true, lock };
  }

  releaseLock(sheetId: string, clientId: string): void {
    this.db
      .prepare('DELETE FROM locks WHERE sheet_id = ? AND client_id = ?')
      .run(sheetId, clientId);
  }

  getRates(base: string): { payload: unknown; fetchedAt: string } | null {
    const row = this.db
      .prepare('SELECT payload, fetched_at FROM rates WHERE base = ?')
      .get(base) as unknown as { payload: string; fetched_at: string } | undefined;
    if (!row) return null;
    return { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at };
  }

  getHolidays(country: string): { payload: unknown; fetchedAt: string } | null {
    const row = this.db
      .prepare('SELECT payload, fetched_at FROM holidays WHERE country = ?')
      .get(country) as unknown as { payload: string; fetched_at: string } | undefined;
    if (!row) return null;
    return { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at };
  }

  saveHolidays(country: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO holidays (country, payload, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(country) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(country, JSON.stringify(payload), new Date().toISOString());
  }

  saveRates(base: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO rates (base, payload, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(base) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(base, JSON.stringify(payload), new Date().toISOString());
  }
}

function toSheet(row: SheetRow): Sheet {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    version: row.version,
    folderId: row.folder_id ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: Omit<SheetRow, 'content'> & { lines: number }): SheetSummary {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    lines: row.lines,
    folderId: row.folder_id ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
