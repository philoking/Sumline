import type { RateTable } from '@webcalc/engine';

export interface User {
  id: string;
  name: string;
}

export interface SheetSummary {
  id: string;
  title: string;
  version: number;
  /** Number of lines in the sheet, counted server-side for the sheet list. */
  lines: number;
  /** Whose space this sheet lives in. */
  owner: string;
  /** Colour-coding token from `SHEET_COLORS`, or null for none. */
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
  /** Colour-coding token from `SHEET_COLORS`, or null for none. */
  color: string | null;
}

export type Statistic = 'total' | 'average' | 'count' | 'median';

export type SheetOrder = 'recent' | 'manual';

export interface Settings {
  statistic?: Statistic;
  /**
   * Whether the sidebar is arranged by hand or by what changed last.
   *
   * Absent means recent, which is what every space had before dragging
   * existed and stays the default for one that never drags anything.
   */
  sheetOrder?: SheetOrder;
  showTotal?: boolean;
  largeNumberNotation?: boolean;
  countVariablesInTotal?: boolean;
  /** This space's own globals. */
  globals?: Record<string, string>;
  /**
   * The globals that apply in every space, and the two tiers resolved.
   *
   * Both are derived by the server and refused by `PUT`, so precedence lives in
   * one place. Send them back and they are ignored — which is what stops an
   * inherited value from being quietly promoted into one of the space's own.
   */
  sharedGlobals?: Record<string, string>;
  effectiveGlobals?: Record<string, string>;
}

export interface SheetQuery {
  folderId?: string | null;
  query?: string;
  trashed?: boolean;
}

export interface Lock {
  sheetId: string;
  clientId: string;
  clientName: string | null;
  expiresAt: number;
}

export interface Sheet extends SheetSummary {
  content: string;
  lock?: Lock | null;
}

/** Thrown when a save is rejected because the sheet moved on without us. */
export class ConflictError extends Error {
  constructor(readonly current: Sheet) {
    super('Sheet was modified elsewhere');
    this.name = 'ConflictError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });

  if (response.status === 409) {
    const body = (await response.json()) as { current: Sheet };
    throw new ConflictError(body.current);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText} ${detail}`.trim());
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface HolidayTable {
  country: string;
  dates: string[];
  years: number[];
  stale?: boolean;
}

export const api = {
  rates: () => request<RateTable>('/api/rates'),

  holidays: () => request<HolidayTable>('/api/holidays'),

  listSheets: (filter: SheetQuery = {}) => {
    const params = new URLSearchParams();
    if (filter.folderId !== undefined) params.set('folder', filter.folderId ?? '');
    if (filter.query) params.set('q', filter.query);
    if (filter.trashed) params.set('trash', '1');
    const suffix = params.toString();
    return request<{ sheets: SheetSummary[] }>(
      `/api/sheets${suffix ? `?${suffix}` : ''}`,
    ).then((r) => r.sheets);
  },

  settings: () => request<Settings>('/api/settings'),

  /**
   * Replaces the globals that apply in every space.
   *
   * Not cookie-scoped, unlike everything else here: the point of this tier is
   * that it is not per space.
   */
  saveSharedGlobals: (globals: Record<string, string>) =>
    request<{ globals: Record<string, string> }>('/api/settings/shared', {
      method: 'PUT',
      body: JSON.stringify({ globals }),
    }),

  saveSettings: (values: Settings) =>
    request<Settings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(values),
    }),

  listFolders: () =>
    request<{ folders: Folder[] }>('/api/folders').then((r) => r.folders),

  createFolder: (name: string) =>
    request<Folder>('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }),

  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (id: string) =>
    request<{ deleted: boolean }>(`/api/folders/${id}`, { method: 'DELETE' }),

  restoreSheet: (id: string) =>
    request<{ restored: boolean }>(`/api/sheets/${id}/restore`, { method: 'POST' }),

  emptyTrash: () => request<{ purged: number }>('/api/trash', { method: 'DELETE' }),

  getSheet: (id: string) => request<Sheet>(`/api/sheets/${id}`),

  createSheet: (title: string, content = '', folderId: string | null = null) =>
    request<Sheet>('/api/sheets', {
      method: 'POST',
      body: JSON.stringify({ title, content, folderId }),
    }),

  saveSheet: (
    id: string,
    changes: { title?: string; content?: string; folderId?: string | null },
    version: number,
  ) =>
    request<Sheet>(`/api/sheets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...changes, version }),
    }),

  /** Moves to the trash by default; `purge` removes it permanently. */
  deleteSheet: (id: string, purge = false) =>
    request<{ deleted: boolean }>(
      `/api/sheets/${id}${purge ? '?purge=1' : ''}`,
      { method: 'DELETE' },
    ),

  /** Every space on this instance, and which one we are working in now. */
  users: () => request<{ users: User[]; current: string }>('/api/users'),

  /** Adds a space. The id comes from the name unless one is given. */
  createSpace: (name: string, id?: string) =>
    request<User>('/api/spaces', {
      method: 'POST',
      body: JSON.stringify(id ? { name, id } : { name }),
    }),

  /** Changes the name shown. The id, and so the sheets, are untouched. */
  renameSpace: (id: string, name: string) =>
    request<User>(`/api/spaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /**
   * Removes a space, leaving its sheets in the database.
   *
   * `hidden` counts what went out of sight, so the caller can say what
   * happened rather than implying the work was destroyed.
   */
  deleteSpace: (id: string) =>
    request<{ deleted: boolean; hidden: number }>(
      `/api/spaces/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  /**
   * Colours a sheet. Null clears it.
   *
   * Its own endpoint rather than part of a save, because colour is how a sheet
   * is filed rather than what it says: this leaves the version and the
   * modified time alone, so tagging a sheet cannot collide with someone
   * editing it and does not jump it to the top of the list.
   */
  setSheetColor: (id: string, color: string | null) =>
    request<{ id: string; color: string | null }>(`/api/sheets/${id}/color`, {
      method: 'PUT',
      body: JSON.stringify({ color }),
    }),

  /** Colours a folder. Null clears it. */
  setFolderColor: (id: string, color: string | null) =>
    request<{ id: string; color: string | null }>(`/api/folders/${id}/color`, {
      method: 'PUT',
      body: JSON.stringify({ color }),
    }),

  /**
   * Puts the sheets in the given order and switches the space to manual.
   *
   * Send the ids as they are displayed. Only the positions those sheets
   * already hold get reassigned, so reordering inside a folder or a search
   * leaves everything off screen where it was.
   */
  reorderSheets: (ids: string[]) =>
    request<{ ordered: boolean }>('/api/sheets/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }),

  /** Mints (or returns) the slug this sheet is shared under. */
  shareSheet: (id: string) =>
    request<{ slug: string }>(`/api/sheets/${id}/share`, { method: 'POST' }),

  resolveSlug: (slug: string) =>
    request<{ id: string }>(`/api/sheets/by-slug/${encodeURIComponent(slug)}`).then(
      (r) => r.id,
    ),

  acquireLock: (id: string, clientId: string, clientName: string, force = false) =>
    request<{ granted: boolean; lock: Lock; ttlMs: number }>(
      `/api/sheets/${id}/lock`,
      {
        method: 'POST',
        body: JSON.stringify({ clientId, clientName, force }),
      },
    ),

  releaseLock: (id: string, clientId: string) =>
    request<void>(`/api/sheets/${id}/lock?clientId=${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
    }),
};

/**
 * Switches which space this browser works in, and remembers it.
 *
 * A plain cookie because the server needs it on every request to filter the
 * sheet list; a year because the answer only changes when someone else sits
 * down at this machine. Not `secure`, since a self-hosted instance is often
 * reached over plain HTTP — and there is nothing here to protect anyway.
 */
export function switchUser(id: string): void {
  const year = 60 * 60 * 24 * 365;
  document.cookie = `webcalc_user=${encodeURIComponent(id)}; path=/; max-age=${year}; samesite=lax`;
}

/**
 * A stable per-browser identity, used for lock ownership. Not authentication:
 * it only distinguishes one tab's browser from another's.
 */
export function clientIdentity(): { id: string; name: string } {
  const KEY = 'webcalc.client';
  const stored = localStorage.getItem(KEY);
  if (stored) return JSON.parse(stored) as { id: string; name: string };
  const identity = { id: randomId(), name: guessName() };
  localStorage.setItem(KEY, JSON.stringify(identity));
  return identity;
}

/**
 * A random client id that works over plain HTTP.
 *
 * `crypto.randomUUID` exists only in a secure context, so on a self-hosted
 * instance reached as http://host:port it is undefined — which is exactly the
 * deployment this project is built for. `getRandomValues` has no such
 * restriction.
 */
function randomId(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // Set the version (4) and variant bits so the value is a well-formed UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function guessName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox/.test(ua)
    ? 'Firefox'
    : /Edg/.test(ua)
      ? 'Edge'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  const platform = /Windows/.test(ua)
    ? 'Windows'
    : /Mac/.test(ua)
      ? 'Mac'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : '';
  return platform ? `${browser} on ${platform}` : browser;
}
