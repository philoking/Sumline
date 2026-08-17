import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FALLBACK_SPACE, type Space } from './spaces.js';

/**
 * The space a row belongs to.
 *
 * A plain string rather than a union of known ids: who has a space is read
 * from configuration at startup (see [`spaces.ts`](./spaces.ts)), so there is
 * no set of them for the compiler to know about. The store treats an owner as
 * an opaque tag and never asks whether it is one of the configured spaces —
 * that check belongs to the layer that has the configuration.
 */
export type UserId = string;

export interface Sheet {
  id: string;
  title: string;
  content: string;
  version: number;
  owner: UserId;
  /**
   * A colour-coding token such as `red`, or null for none.
   *
   * A name rather than a hex, because the app follows the reader's light or
   * dark theme and a colour picked under one would be wrong under the other.
   * The token is opaque here — which shades it means is the web's business.
   */
  color: string | null;
  folderId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: string;
  name: string;
  position: number;
  /** Colour-coding token, as on a sheet. Null for none. */
  color: string | null;
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
  color: string | null;
  position: number | null;
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

-- Who has a space, in the order the switcher lists them.
--
-- Rows rather than configuration, so a space can be added from the app without
-- a redeploy. SPACES seeds this table on an instance that has none and is
-- ignored once it does — otherwise a space added in the app would vanish on
-- the next restart, or a person removed in the app would come back.
CREATE TABLE IF NOT EXISTS spaces (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
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
  /** The space rows that predate the owner column are adopted into. */
  private readonly defaultOwner: string;

  constructor(path: string, defaultOwner: string = FALLBACK_SPACE.id) {
    // Interpolated into a DEFAULT clause below, where a bound parameter is not
    // allowed. Every id reaching here has been through deriveSpaceId, and this
    // re-checks rather than trusting the caller, because the consequence of a
    // stray quote in DDL is worse than a startup failure.
    if (!/^[a-z0-9-]+$/.test(defaultOwner)) {
      throw new Error(`Unusable space id: ${JSON.stringify(defaultOwner)}`);
    }
    this.defaultOwner = defaultOwner;
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
    // Colour coding, added later than the tables. Null means uncoloured, which
    // is why there is no DEFAULT: an existing sheet has not chosen a colour
    // rather than having chosen a particular one.
    this.addColumn('sheets', 'color', 'TEXT');
    this.addColumn('folders', 'color', 'TEXT');
    // Where a sheet sits when the space orders its list by hand. Null until
    // the first drag, which is what tells manual order from an arrangement
    // that happens to start at zero.
    this.addColumn('sheets', 'position', 'INTEGER');
    // Everything that existed before there were spaces belongs to the default
    // one, so nobody opens the app to find their sheets gone.
    //
    // The default is fixed when the column is added and no later configuration
    // change rewrites it — which is correct, since it describes who owned the
    // data at the moment spaces arrived, not who is configured today.
    const owner = `TEXT NOT NULL DEFAULT '${this.defaultOwner}'`;
    this.addColumn('sheets', 'owner', owner);
    this.addColumn('folders', 'owner', owner);
    this.adoptPreUserSettings();
  }

  /** Who has a space, in switcher order. */
  listSpaces(): Space[] {
    const rows = this.db
      .prepare('SELECT id, name FROM spaces ORDER BY position, id')
      .all() as unknown as Space[];
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /**
   * Fills an empty space table, and does nothing to one that has rows.
   *
   * The guard is what makes `SPACES` a seed rather than an instruction: a
   * space added in the app must survive the next restart, and a person removed
   * in the app must not reappear because the variable still names them.
   */
  seedSpaces(spaces: readonly Space[]): boolean {
    if (spaces.length === 0) return false;
    const existing = this.db.prepare('SELECT 1 FROM spaces LIMIT 1').get();
    if (existing) return false;
    const insert = this.db.prepare(
      'INSERT INTO spaces (id, name, position) VALUES (?, ?, ?)',
    );
    spaces.forEach((space, index) => insert.run(space.id, space.name, index));
    return true;
  }

  /** Adds a space. Null when the id is taken, which the caller reports as a conflict. */
  createSpace(id: string, name: string): Space | null {
    const taken = this.db.prepare('SELECT 1 FROM spaces WHERE id = ?').get(id);
    if (taken) return null;
    const row = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM spaces')
      .get() as unknown as { next: number };
    this.db
      .prepare('INSERT INTO spaces (id, name, position) VALUES (?, ?, ?)')
      .run(id, name, row.next);
    return { id, name };
  }

  /**
   * Changes the name shown, never the id.
   *
   * The id is stamped on every sheet, folder and setting, so renaming someone
   * has to leave it alone or the rename would read as a deletion.
   */
  renameSpace(id: string, name: string): boolean {
    const result = this.db
      .prepare('UPDATE spaces SET name = ? WHERE id = ?')
      .run(name, id);
    return result.changes > 0;
  }

  /**
   * Removes a space, leaving everything it owns in place.
   *
   * Deliberately not a cascade. Sheets keep their owner id and become
   * unreachable rather than destroyed, so a person removed by mistake is
   * restored by adding them back under the same id.
   */
  deleteSpace(id: string): boolean {
    const result = this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** How much a space would take out of sight if it were removed. */
  countOwned(owner: string): number {
    const row = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sheets WHERE owner = ?)
              + (SELECT COUNT(*) FROM folders WHERE owner = ?) AS total`,
      )
      .get(owner, owner) as unknown as { total: number };
    return row.total;
  }

  /**
   * Every space id the database actually holds data for.
   *
   * Read from the rows rather than from the space table, so the caller can
   * tell whether the spaces that exist account for what is stored.
   */
  owners(): string[] {
    const rows = this.db
      .prepare(
        `SELECT owner FROM sheets
         UNION SELECT owner FROM folders
         UNION SELECT owner FROM user_settings
         ORDER BY owner`,
      )
      .all() as unknown as Array<{ owner: string }>;
    return rows.map((row) => row.owner).filter(Boolean);
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
      .get(this.defaultOwner);
    if (already) return;
    this.db
      .prepare(
        `INSERT INTO user_settings (owner, key, value)
         SELECT ?, key, value FROM settings`,
      )
      .run(this.defaultOwner);
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
    filter: {
      folderId?: string | null;
      query?: string;
      trashed?: boolean;
      /** Order by hand rather than by when each sheet last changed. */
      manualOrder?: boolean;
    } = {},
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

    // A sheet with no position has never been placed — it was made after the
    // list was last arranged — so it sorts above the arranged ones, newest
    // first. A new sheet appearing at the top is what the recency order would
    // have done too; dropping it silently at the bottom of a long list is the
    // behaviour that would look like a bug.
    // `rowid DESC` breaks ties on the timestamp, which is not the corner case
    // it looks like: two sheets saved in the same millisecond compare equal,
    // and SQLite is then free to return them in either order from one request
    // to the next — a list that reshuffles itself between refreshes. Falling
    // back to insertion order keeps the newer sheet above the older one, which
    // is what the recency order was claiming to do anyway.
    const order = filter.manualOrder
      ? 'position IS NULL DESC, position ASC, updated_at DESC, rowid DESC'
      : 'updated_at DESC, rowid DESC';

    // The line count is derived in SQL so the list endpoint never has to ship
    // sheet bodies just to say how long they are.
    const rows = this.db
      .prepare(
        `SELECT id, title, version, owner, color, position, folder_id, deleted_at, created_at, updated_at,
                CASE WHEN content = '' THEN 0
                     ELSE length(content) - length(replace(content, char(10), '')) + 1
                END AS lines
         FROM sheets WHERE ${where.join(' AND ')} ORDER BY ${order}`,
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
      color: null,
      folderId,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Colours a sheet, without touching its version or `updated_at`.
   *
   * Colour is how a sheet is filed, not what it says. Bumping the version
   * would make a colour change collide with someone else's edit, and touching
   * `updated_at` would jump the sheet to the top of a list ordered by when it
   * last changed — for a change that did not alter a single line.
   */
  setSheetColor(id: string, color: string | null): boolean {
    return (
      this.db.prepare('UPDATE sheets SET color = ? WHERE id = ?').run(color, id)
        .changes > 0
    );
  }

  /**
   * Gives every live sheet in a space a position, in the order it shows now.
   *
   * Called before any reorder so the arrangement starts from what was on
   * screen rather than rearranging itself the moment the list is first
   * dragged. Safe to run repeatedly: renumbering the current display order is
   * a no-op once every sheet already has a position.
   */
  seedSheetOrder(owner: UserId): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM sheets
          WHERE owner = ? AND deleted_at IS NULL
          ORDER BY position IS NULL DESC, position ASC, updated_at DESC, rowid DESC`,
      )
      .all(owner) as unknown as Array<{ id: string }>;
    const update = this.db.prepare(
      'UPDATE sheets SET position = ? WHERE id = ? AND owner = ?',
    );
    rows.forEach((row, index) => update.run(index, row.id, owner));
  }

  /**
   * Rearranges sheets into the given order.
   *
   * Only the positions these sheets already hold are handed back out, in the
   * new order. That is what keeps a reorder inside a folder — or inside a
   * search — from disturbing anything not on screen: the slots are borrowed
   * from the visible set and returned to it, so no sheet outside the filter
   * can be pushed anywhere. Ids that are not this owner's live sheets are
   * ignored rather than trusted.
   */
  reorderSheets(owner: UserId, ids: readonly string[]): boolean {
    // Decided before anything is written. Seeding first would mean a request
    // this method goes on to refuse had already stamped a position onto every
    // sheet in the space — a rejected call with a side effect, which is how a
    // stray request ends up silently rearranging someone's list.
    const live = new Set(
      (
        this.db
          .prepare(
            `SELECT id FROM sheets WHERE owner = ? AND deleted_at IS NULL`,
          )
          .all(owner) as unknown as Array<{ id: string }>
      ).map((row) => row.id),
    );
    if (ids.filter((id) => live.has(id)).length < 2) return false;

    this.seedSheetOrder(owner);

    const known = new Map(
      (
        this.db
          .prepare(
            `SELECT id, position FROM sheets
              WHERE owner = ? AND deleted_at IS NULL`,
          )
          .all(owner) as unknown as Array<{ id: string; position: number }>
      ).map((row) => [row.id, row.position]),
    );

    const moving = ids.filter((id) => known.has(id));
    const slots = moving.map((id) => known.get(id)!).sort((a, b) => a - b);
    const update = this.db.prepare(
      'UPDATE sheets SET position = ? WHERE id = ? AND owner = ?',
    );
    moving.forEach((id, index) => update.run(slots[index]!, id, owner));
    return true;
  }

  /** Colours a folder. Scoped to its owner, as renaming one is. */
  setFolderColor(id: string, color: string | null, owner: UserId): boolean {
    return (
      this.db
        .prepare('UPDATE folders SET color = ? WHERE id = ? AND owner = ?')
        .run(color, id, owner).changes > 0
    );
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
        'SELECT id, name, position, color FROM folders WHERE owner = ? ORDER BY position, name',
      )
      .all(owner) as unknown as Folder[];
  }

  createFolder(owner: UserId, name: string): Folder {
    const id = randomUUID();
    const position = this.listFolders(owner).length;
    this.db
      .prepare('INSERT INTO folders (id, name, position, owner) VALUES (?, ?, ?, ?)')
      .run(id, name, position, owner);
    return { id, name, position, color: null };
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
    owner: row.owner,
    color: row.color ?? null,
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
    owner: row.owner,
    color: row.color ?? null,
    folderId: row.folder_id ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
