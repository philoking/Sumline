import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type SheetMatch, type SheetSummary } from './api';
import { Snippet } from './Snippet';
import { formatShortcut } from './shortcuts';
import { useDialog } from './useDialog';
import { Backdrop } from './Popover';

/** How long a keystroke sits before the server is asked about it. */
const SEARCH_DELAY_MS = 130;

/**
 * How many rows are offered.
 *
 * A cap rather than a scroll to the end: past a screenful the list has stopped
 * being a way to choose and become a way to browse, which is what the sidebar
 * is for. The footer says when rows were left out, so a capped list never
 * passes itself off as the whole answer.
 */
const MAX_ROWS = 40;

/**
 * One offer in the list.
 *
 * A sheet found by its name and a sheet found by its text are the same kind of
 * thing here — both open a sheet — and differ only in whether they know a line
 * to land on. Keeping that as one row type is what lets the two scopes share a
 * list instead of sitting in two panes.
 */
interface Row {
  id: string;
  title: string;
  /** The body line to land on, or null when the name is what matched. */
  line: number | null;
  match?: SheetMatch;
  /** Length in lines, shown when there is no match to quote instead. */
  lines: number;
}

export interface PaletteProps {
  open: boolean;
  /** The sheets already loaded, offered before anything is typed. */
  recent: SheetSummary[];
  /** Opens a sheet, scrolled to `line` when the text is what was found. */
  onOpen(id: string, line: number | null): void;
  onClose(): void;
}

/**
 * Splits search results into name matches and text matches, names first.
 *
 * A sheet whose title contains the term is offered as itself: the reader asked
 * for it by name, and dropping them at whichever body line happened to match
 * first would answer a question they did not ask. Everything else got into the
 * list because its text matched, so it carries the line that did.
 */
function toRows(sheets: SheetSummary[], query: string): Row[] {
  const needle = query.trim().toLowerCase();
  const named: Row[] = [];
  const text: Row[] = [];

  for (const sheet of sheets) {
    const row = { id: sheet.id, title: sheet.title, lines: sheet.lines };
    if (sheet.match && !sheet.title.toLowerCase().includes(needle)) {
      text.push({ ...row, line: sheet.match.line, match: sheet.match });
    } else {
      named.push({ ...row, line: null });
    }
  }

  return [...named, ...text];
}

export function Palette({ open, recent, onOpen, onClose }: PaletteProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<SheetSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLLIElement | null>(null);
  // Escape is handled on the input, which owns the keyboard here; this is for
  // putting focus back where it was when the palette closes.
  const panelRef = useDialog<HTMLDivElement>(open, onClose);

  /**
   * Every sheet on the list before a search, so the palette opens on something
   * useful — the same sheets the sidebar is showing, in the same order.
   */
  const rows = useMemo<Row[]>(() => {
    if (query.trim() === '') {
      return recent.map((sheet) => ({
        id: sheet.id,
        title: sheet.title,
        line: null,
        lines: sheet.lines,
      }));
    }
    return found ? toRows(found, query) : [];
  }, [query, recent, found]);

  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;

  // Reopening starts clean. A palette that came back holding the last search
  // would answer a question asked minutes ago, against sheets that have since
  // moved on.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setFound(null);
    setSearching(false);
    setActive(0);
  }, [open]);

  /*
   * The search itself, debounced.
   *
   * `listSheets` is the same call the sidebar makes, so the two search the same
   * way by construction: title and body, current space, trash left out. The
   * cross-sheet scope needed no new endpoint — this one already returned the
   * matching line, it simply had nowhere keyboard-reachable to appear.
   */
  useEffect(() => {
    const needle = query.trim();
    if (!open || needle === '') {
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      void api
        .listSheets({ query: needle })
        .then((sheets) => {
          // Dropped rather than shown if the query moved on: a slow answer to
          // an old keystroke would otherwise overwrite a fresh one.
          if (cancelled) return;
          setFound(sheets);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setFound([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query]);

  // Keep the highlighted row on screen when it is reached with the keyboard.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (row: Row) => {
    onOpen(row.id, row.line);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Wrapped, because the list is short: pressing up from the top to reach
      // the last row is quicker than holding down through forty of them.
      setActive((current) => (current + step + shown.length) % shown.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = shown[active];
      if (row) choose(row);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <Backdrop onClose={onClose} />
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Go to a sheet, or find text in any sheet"
        ref={panelRef}
      >
        <input
          className="palette-input"
          type="text"
          value={query}
          placeholder="Go to a sheet, or find text in any sheet"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={shown[active] ? `palette-row-${active}` : undefined}
          aria-autocomplete="list"
          autoFocus
        />

        <ul className="palette-results" id="palette-results" role="listbox">
          {shown.map((row, index) => (
            <li
              key={`${row.id}:${row.line ?? 'name'}`}
              id={`palette-row-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              ref={index === active ? activeRef : undefined}
            >
              <button
                type="button"
                // On hover rather than on move, so the row under a resting
                // pointer does not steal the highlight from the arrow keys.
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                <span className="palette-title">{row.title}</span>
                {row.match && <Snippet match={row.match} />}
                <span className="palette-where">
                  {row.line !== null
                    ? `line ${row.line}`
                    : row.lines === 1
                      ? '1 line'
                      : `${row.lines} lines`}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {shown.length === 0 && (
          <p className="palette-empty">
            {query.trim() === ''
              ? 'No sheets yet.'
              : searching
                ? 'Searching…'
                : `Nothing matches “${query.trim()}”.`}
          </p>
        )}

        <footer className="palette-foot">
          <span>
            {formatShortcut(['Enter'])} open · ↑↓ move · {formatShortcut(['Escape'])}{' '}
            close
          </span>
          {hidden > 0 && <span>{hidden} more not shown</span>}
        </footer>
      </div>
    </>
  );
}
