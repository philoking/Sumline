import type { RateTable } from '@webcalc/engine';

export interface SheetSummary {
  id: string;
  title: string;
  version: number;
  /** Number of lines in the sheet, counted server-side for the sheet list. */
  lines: number;
  createdAt: string;
  updatedAt: string;
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

  listSheets: () =>
    request<{ sheets: SheetSummary[] }>('/api/sheets').then((r) => r.sheets),

  getSheet: (id: string) => request<Sheet>(`/api/sheets/${id}`),

  createSheet: (title: string, content = '') =>
    request<Sheet>('/api/sheets', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    }),

  saveSheet: (
    id: string,
    changes: { title?: string; content?: string },
    version: number,
  ) =>
    request<Sheet>(`/api/sheets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...changes, version }),
    }),

  deleteSheet: (id: string) =>
    request<{ deleted: boolean }>(`/api/sheets/${id}`, { method: 'DELETE' }),

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
