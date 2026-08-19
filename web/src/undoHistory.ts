/**
 * A sheet's undo stack, kept across reloads.
 *
 * CodeMirror's `history()` lives in editor state, so it lasts exactly as long
 * as the tab does: reloading leaves ⌘Z with nothing to undo, in an app whose
 * every other editor has trained people to expect otherwise. The stack is
 * serialised here instead, keyed by sheet.
 *
 * Every entry records the document it was taken against, and a stack is handed
 * back only when that document matches the one being opened. This is the whole
 * safety property of the module: an undo is a change expressed in positions,
 * so replaying one over text it was not recorded against does not fail — it
 * quietly rewrites the wrong span. A stack that cannot be shown to belong to
 * what is on screen is therefore dropped, which is what makes this safe when a
 * sheet was edited in another tab, on another device, or by someone else while
 * this one was closed.
 */

/** Bumped if the stored shape ever changes, so old entries are ignored rather than misread. */
const KEY = 'sumline.undo.v1';

/**
 * How many sheets keep a stack.
 *
 * Least recently written are dropped past this. A person moves between a
 * handful of sheets in a sitting, and the ones before that are the ones whose
 * undo stack they have long since stopped reaching for.
 */
const MAX_SHEETS = 12;

/**
 * How much text one sheet's entry may hold, documents and changes together.
 *
 * A guard against a pasted log file taking the whole origin's storage quota
 * with it. Past this the stack is dropped rather than trimmed: half a history
 * is not a shorter history, it is one whose oldest change no longer applies to
 * anything.
 */
const MAX_ENTRY_CHARS = 256_000;

export interface SavedHistory {
  /** The document this stack was recorded against. */
  doc: string;
  /**
   * The serialised editor state, opaque here.
   *
   * The whole state rather than the history field alone, because CodeMirror
   * reads a document and a selection back out of the same object — and because
   * it means the caret comes back where it was left, which is half of what
   * makes a restored stack feel like the session simply continuing.
   */
  snapshot: unknown;
  /** When it was written, for dropping the least recently used. */
  at: number;
}

type Store = Record<string, SavedHistory>;

/**
 * The backing store, or null where there is none.
 *
 * Private browsing modes and storage-blocking settings make `localStorage`
 * throw on access rather than merely be absent, so this is guarded rather than
 * checked. Every caller treats null as "no stack was kept", which is the
 * behaviour the app had before this module existed.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(): Store {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written value is discarded rather than trusted:
    // everything below indexes into this by sheet id.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(KEY, JSON.stringify(store));
  } catch {
    // Over quota, or storage refused. Undo across reloads is a convenience;
    // failing to keep it must never surface as an error over someone's sheet.
    try {
      target.removeItem(KEY);
    } catch {
      // Nothing further to try.
    }
  }
}

/** Drops the least recently written entries until the store is within its cap. */
function prune(store: Store): Store {
  const ids = Object.keys(store);
  if (ids.length <= MAX_SHEETS) return store;
  const keep = ids
    .sort((a, b) => (store[b]?.at ?? 0) - (store[a]?.at ?? 0))
    .slice(0, MAX_SHEETS);
  return Object.fromEntries(keep.map((id) => [id, store[id]!]));
}

/**
 * The stack kept for this sheet, or null when there is none that fits.
 *
 * `doc` is the text the stack would be replayed over, and an entry recorded
 * against anything else is refused — see the note at the top of the file.
 *
 * A refusal leaves the entry in place rather than clearing it, which is what
 * makes this safe to ask speculatively. Selecting a sheet changes its id a
 * render before its text arrives, so the editor asks once with the outgoing
 * sheet's text still on screen and again when the real text lands; clearing on
 * the first of those would destroy the stack the second was coming back for.
 * Entries that never fit again are dropped by the cap instead.
 */
export function loadUndoHistory(sheetId: string, doc: string): unknown | null {
  const entry = read()[sheetId];
  if (!entry || typeof entry.doc !== 'string') return null;
  if (entry.doc !== doc) return null;
  return entry.snapshot ?? null;
}

/**
 * Keeps this sheet's stack against the document it was taken from.
 *
 * The pair is written together and never separately, because an entry whose
 * document and snapshot came from different moments is precisely the thing
 * `loadUndoHistory` exists to refuse.
 */
export function saveUndoHistory(sheetId: string, doc: string, snapshot: unknown): void {
  const entry: SavedHistory = { doc, snapshot, at: Date.now() };
  const encoded = JSON.stringify(entry);
  if (encoded.length > MAX_ENTRY_CHARS) {
    forgetUndoHistory(sheetId);
    return;
  }
  const store = read();
  store[sheetId] = entry;
  write(prune(store));
}

/** Forgets a sheet's stack — when it is deleted, or found not to match. */
export function forgetUndoHistory(sheetId: string): void {
  const store = read();
  if (!(sheetId in store)) return;
  delete store[sheetId];
  write(store);
}
