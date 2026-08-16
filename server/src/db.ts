import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Who can be using the app.
 *
 * There are no passwords: this is a space to work in, not a security boundary,
 * and anyone who can reach the app can be anyone. That matches an instance
 * with no authentication at all on a trusted network. Adding a third person is
 * one entry here.
 */
export const USERS = [
  { id: 'jason', name: 'Jason' },
  { id: 'kim', name: 'Kim' },
] as const;

export type UserId = (typeof USERS)[number]['id'];

/** The space sheets predating the user model belong to. */
export const DEFAULT_USER: UserId = 'jason';

export function isUser(value: unknown): value is UserId {
  return USERS.some((user) => user.id === value);
}

/** Resolves any untrusted value to a real user, falling back to the default. */
export function toUser(value: unknown): UserId {
  return isUser(value) ? value : DEFAULT_USER;
}

export interface Sheet {
  id: string;
  title: string;
  content: string;
  version: number;
  owner: UserId;
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

/**
 * Removes characters a text sheet cannot hold.
 *
 * A NUL byte survives the write but comes back truncated at that point, so
 * text after it would be silently lost. Stripping on the way in means what is
 * read back always matches what was stored.
 */
export function sanitiseText(value: string): string {
  return value.replace(/\u0000/g, '');
}

/** Names an untitled sheet from its first meaningful line. */
export function deriveTitle(current: string, content: string): string {
  if (current && current !== 'Untitled') return current;
  const first = content
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);
  return first ? first.slice(0, 60) : 'Untitled';
}

/**
 * Turns a sheet title into the readable half of a share link.
 *
 * Accents are decomposed and their marks dropped so "Café budget" becomes
 * "cafe-budget" rather than losing the word. A title with nothing ASCII in it
 * at all yields an empty string, so callers get "sheet" and the uniqueness
 * pass numbers it from there.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    // The slice can land mid-separator, and both ends are trimmed after it so
    // a truncated slug never ends in a dash.
    .replace(/-+$/, '');
  return slug || 'sheet';
}

/**
 * Whether an existing slug still describes this title.
 *
 * A slug matches either exactly or with the numeric suffix uniqueness added,
 * which is what keeps re-sharing an unrenamed sheet stable. Comparing whole
 * candidates rather than stripping a trailing `-2` matters for a title that
 * genuinely ends in a number: "Trip 2026" must not be read as "Trip" plus a
 * collision suffix, or every share would mint a new link.
 */
function slugMatchesTitle(slug: string, desired: string): boolean {
  if (slug === desired) return true;
  if (!slug.startsWith(`${desired}-`)) return false;
  return /^\d+$/.test(slug.slice(desired.length + 1));
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
  owner: string;
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

-- Settings are per person, not per instance: display preferences are personal,
-- and the global variables change what a sheet computes, so one space's values
-- must never leak into the other's answers. The pre-user settings table above
-- is migrated into here once and then left alone.
CREATE TABLE IF NOT EXISTS user_settings (
  owner TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (owner, key)
);

-- Every slug a sheet has ever been shared under, not just its current one, so
-- renaming a shared sheet does not break a link already sent to someone.
CREATE TABLE IF NOT EXISTS sheet_slugs (
  slug     TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets (id) ON DELETE CASCADE
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
    // The slug a sheet is currently shared under. Null until it is first
    // shared, so the many sheets that are never sent to anyone mint nothing.
    this.addColumn('sheets', 'slug', 'TEXT');
    // Everything that existed before there were spaces belongs to the default
    // one, so nobody opens the app to find their sheets gone.
    this.addColumn('sheets', 'owner', `TEXT NOT NULL DEFAULT '${DEFAULT_USER}'`);
    this.addColumn('folders', 'owner', `TEXT NOT NULL DEFAULT '${DEFAULT_USER}'`);
    this.adoptPreUserSettings();
  }

  /**
   * Moves instance-wide settings into the default user's space, once.
   *
   * Guarded on the destination being empty rather than on the source, so a
   * second run cannot overwrite preferences changed since the first. The old
   * rows are left in place: they cost nothing and make a rollback to the
   * previous release land on the settings it expects.
   */
  private adoptPreUserSettings(): void {
    const already = this.db
      .prepare('SELECT 1 FROM user_settings WHERE owner = ? LIMIT 1')
      .get(DEFAULT_USER);
    if (already) return;
    this.db
      .prepare(
        `INSERT INTO user_settings (owner, key, value)
         SELECT ?, key, value FROM settings`,
      )
      .run(DEFAULT_USER);
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
    owner: UserId,
    filter: { folderId?: string | null; query?: string; trashed?: boolean } = {},
  ): SheetSummary[] {
    const where: string[] = [
      'owner = ?',
      filter.trashed ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    const params: unknown[] = [owner];

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
        `SELECT id, title, version, owner, folder_id, deleted_at, created_at, updated_at,
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

  /**
   * Returns the slug this sheet should be shared under, minting one if needed.
   *
   * Slugs are created here rather than at sheet creation so the sheets that
   * are never shared — most of them, and all the ones still called "Untitled"
   * — never take a name. Re-sharing an unrenamed sheet returns the same slug;
   * renaming and sharing again mints a fresh one and leaves the old pointing
   * here, so a link already sent to someone keeps working.
   */
  shareSheet(id: string): string | null {
    const sheet = this.getSheet(id);
    if (!sheet) return null;

    const desired = slugify(sheet.title);
    const current = this.currentSlug(id);
    if (current && slugMatchesTitle(current, desired)) return current;

    const slug = this.uniqueSlug(desired);
    this.db
      .prepare('INSERT INTO sheet_slugs (slug, sheet_id) VALUES (?, ?)')
      .run(slug, id);
    this.db.prepare('UPDATE sheets SET slug = ? WHERE id = ?').run(slug, id);
    return slug;
  }

  /** Resolves any slug a sheet has ever held, current or superseded. */
  resolveSlug(slug: string): string | null {
    const row = this.db
      .prepare('SELECT sheet_id FROM sheet_slugs WHERE slug = ?')
      .get(slug) as unknown as { sheet_id: string } | undefined;
    return row?.sheet_id ?? null;
  }

  private currentSlug(id: string): string | null {
    const row = this.db
      .prepare('SELECT slug FROM sheets WHERE id = ?')
      .get(id) as unknown as { slug: string | null } | undefined;
    return row?.slug ?? null;
  }

  /**
   * Numbers a slug until it is unused: `budget`, `budget-2`, `budget-3`.
   *
   * Uniqueness is checked against every slug ever issued, not just the ones
   * currently in use, so a new sheet can never take a name that would hijack
   * an old link. The bound is a backstop against a pathological run of
   * same-titled sheets; past it, uniqueness matters more than readability.
   */
  private uniqueSlug(desired: string): string {
    const taken = this.db.prepare('SELECT 1 FROM sheet_slugs WHERE slug = ?');
    if (!taken.get(desired)) return desired;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${desired}-${n}`;
      if (!taken.get(candidate)) return candidate;
    }
    return `${desired}-${randomUUID().slice(0, 8)}`;
  }

  createSheet(
    owner: UserId,
    rawTitle: string,
    rawContent = '',
    folderId: string | null = null,
  ): Sheet {
    const title = sanitiseText(rawTitle);
    const content = sanitiseText(rawContent);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sheets (id, title, content, version, owner, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, title, content, owner, folderId, now, now);
    return {
      id,
      title,
      content,
      version: 1,
      owner,
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

    const content = sanitiseText(changes.content ?? current.content);
    const next: Sheet = {
      ...current,
      // An untitled sheet names itself from its first line, so a new sheet
      // does not have to be named before it can be found again.
      title: sanitiseText(changes.title ?? deriveTitle(current.title, content)),
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

  /**
   * Moves a sheet to the trash, where it can still be restored.
   *
   * Destructive operations are the one place a space is a real boundary.
   * Reading and editing another person's sheet through a share link is fine —
   * that is what the link is for, and the lock still serialises the editing —
   * but following a link must never put you one mis-click from deleting work
   * that is not yours.
   */
  trashSheet(id: string, owner: UserId): boolean {
    const result = this.db
      .prepare(
        'UPDATE sheets SET deleted_at = ? WHERE id = ? AND owner = ? AND deleted_at IS NULL',
      )
      .run(new Date().toISOString(), id, owner);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM locks WHERE sheet_id = ?').run(id);
    }
    return result.changes > 0;
  }

  restoreSheet(id: string, owner: UserId): boolean {
    const result = this.db
      .prepare('UPDATE sheets SET deleted_at = NULL WHERE id = ? AND owner = ?')
      .run(id, owner);
    return result.changes > 0;
  }

  /** Permanently removes everything in this space's trash. */
  emptyTrash(owner: UserId): number {
    const result = this.db
      .prepare('DELETE FROM sheets WHERE deleted_at IS NOT NULL AND owner = ?')
      .run(owner);
    return Number(result.changes);
  }

  listFolders(owner: UserId): Folder[] {
    return this.db
      .prepare(
        'SELECT id, name, position FROM folders WHERE owner = ? ORDER BY position, name',
      )
      .all(owner) as unknown as Folder[];
  }

  createFolder(owner: UserId, name: string): Folder {
    const id = randomUUID();
    const position = this.listFolders(owner).length;
    this.db
      .prepare('INSERT INTO folders (id, name, position, owner) VALUES (?, ?, ?, ?)')
      .run(id, name, position, owner);
    return { id, name, position };
  }

  renameFolder(id: string, name: string, owner: UserId): boolean {
    return (
      this.db
        .prepare('UPDATE folders SET name = ? WHERE id = ? AND owner = ?')
        .run(name, id, owner).changes > 0
    );
  }

  /** Deletes a folder; its sheets return to the top level rather than vanishing. */
  deleteFolder(id: string, owner: UserId): boolean {
    const removed =
      this.db
        .prepare('DELETE FROM folders WHERE id = ? AND owner = ?')
        .run(id, owner).changes > 0;
    // Only orphan the sheets once the folder was really this person's, or a
    // mistaken id would empty a folder in the other space.
    if (removed) {
      this.db.prepare('UPDATE sheets SET folder_id = NULL WHERE folder_id = ?').run(id);
    }
    return removed;
  }

  getSettings(owner: UserId): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value FROM user_settings WHERE owner = ?')
      .all(owner) as unknown as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  }

  saveSettings(
    owner: UserId,
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    const statement = this.db.prepare(
      `INSERT INTO user_settings (owner, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(values)) {
      statement.run(owner, key, JSON.stringify(value));
    }
    return this.getSettings(owner);
  }

  deleteSheet(id: string, owner: UserId): boolean {
    const result = this.db
      .prepare('DELETE FROM sheets WHERE id = ? AND owner = ?')
      .run(id, owner);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM locks WHERE sheet_id = ?').run(id);
    }
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
    owner: toUser(row.owner),
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
    owner: toUser(row.owner),
    folderId: row.folder_id ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
