import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Sheet {
  id: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type SheetSummary = Omit<Sheet, 'content'> & { lines: number };

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
  }

  close(): void {
    this.db.close();
  }

  listSheets(): SheetSummary[] {
    // The line count is derived in SQL so the list endpoint never has to ship
    // sheet bodies just to say how long they are.
    const rows = this.db
      .prepare(
        `SELECT id, title, version, created_at, updated_at,
                CASE WHEN content = '' THEN 0
                     ELSE length(content) - length(replace(content, char(10), '')) + 1
                END AS lines
         FROM sheets ORDER BY updated_at DESC`,
      )
      .all() as unknown as Array<Omit<SheetRow, 'content'> & { lines: number }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      version: row.version,
      lines: row.lines,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getSheet(id: string): Sheet | null {
    const row = this.db
      .prepare('SELECT * FROM sheets WHERE id = ?')
      .get(id) as unknown as SheetRow | undefined;
    return row ? toSheet(row) : null;
  }

  createSheet(title: string, content = ''): Sheet {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO sheets (id, title, content, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .run(id, title, content, now, now);
    return {
      id,
      title,
      content,
      version: 1,
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
    changes: { title?: string; content?: string },
    expectedVersion?: number,
  ): Sheet {
    const current = this.getSheet(id);
    if (!current) throw new Error('Sheet not found');

    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new VersionConflictError(current);
    }

    const next: Sheet = {
      ...current,
      title: changes.title ?? current.title,
      content: changes.content ?? current.content,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        'UPDATE sheets SET title = ?, content = ?, version = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.title, next.content, next.version, next.updatedAt, id);

    return next;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
