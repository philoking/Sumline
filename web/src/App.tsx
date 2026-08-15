import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  clientIdentity,
  ConflictError,
  type Lock,
  type Sheet,
  type SheetSummary,
} from './api';
import { Editor } from './Editor';
import { Sidebar } from './Sidebar';
import { useEngine, useResults } from './useEngine';

type Status = 'idle' | 'unsaved' | 'saving' | 'saved' | 'readonly' | 'error';

const AUTOSAVE_DELAY_MS = 800;
const LOCK_HEARTBEAT_MS = 15_000;

export function App() {
  // Large-number notation is Soulver's default, but it is worth being able to
  // switch off until per-line formatting exists.
  const [siNotation, setSiNotation] = useState(
    () => localStorage.getItem('webcalc.si') !== 'off',
  );
  const { engine, rates } = useEngine({ largeNumberNotation: siNotation });
  const identity = useMemo(clientIdentity, []);

  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [version, setVersion] = useState(0);
  const [lock, setLock] = useState<{ granted: boolean; holder: Lock | null }>({
    granted: false,
    holder: null,
  });
  const [conflict, setConflict] = useState<Sheet | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /** The content the server last confirmed, so we never save a no-op. */
  const savedContent = useRef('');
  const results = useResults(engine, content);
  const sheetTotal = useMemo(() => engine.total(results), [engine, results]);

  const refreshSheets = useCallback(async () => {
    const list = await api.listSheets();
    setSheets(list);
    return list;
  }, []);

  const openSheet = useCallback(async (id: string) => {
    const sheet = await api.getSheet(id);
    setTitle(sheet.title);
    setContent(sheet.content);
    setVersion(sheet.version);
    savedContent.current = sheet.content;
    setConflict(null);
    setStatus('idle');
    return sheet;
  }, []);

  // First load: restore the sheet named in the URL, else the most recent one.
  useEffect(() => {
    refreshSheets()
      .then(async (list) => {
        const fromUrl = window.location.hash.replace(/^#\/?/, '');
        const target = list.find((s) => s.id === fromUrl) ?? list[0];
        if (target) {
          setActiveId(target.id);
          return;
        }
        const created = await api.createSheet('Untitled');
        await refreshSheets();
        setActiveId(created.id);
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, [refreshSheets]);

  // Load the sheet and try to claim the editing lock whenever the selection
  // changes. The previous sheet's lock is released on the way out.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    window.location.hash = `/${activeId}`;

    void (async () => {
      try {
        await openSheet(activeId);
        const result = await api.acquireLock(activeId, identity.id, identity.name);
        if (cancelled) return;
        setLock({ granted: result.granted, holder: result.lock });
        setStatus(result.granted ? 'idle' : 'readonly');
      } catch (cause) {
        if (!cancelled) setError(describe(cause));
      }
    })();

    const releasing = activeId;
    return () => {
      cancelled = true;
      void api.releaseLock(releasing, identity.id).catch(() => {
        // The lock expires on its own; a failed release is not worth surfacing.
      });
    };
  }, [activeId, identity.id, identity.name, openSheet]);

  // Hold the lock while this tab is the editor.
  useEffect(() => {
    if (!activeId || !lock.granted) return;
    const timer = setInterval(() => {
      void api
        .acquireLock(activeId, identity.id, identity.name)
        .then((result) => setLock({ granted: result.granted, holder: result.lock }))
        .catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [activeId, lock.granted, identity.id, identity.name]);

  // Best-effort release when the tab goes away, so the next person does not
  // have to wait out the TTL.
  useEffect(() => {
    const release = () => {
      if (!activeId) return;
      const url = `/api/sheets/${activeId}/lock?clientId=${encodeURIComponent(identity.id)}`;
      void fetch(url, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
  }, [activeId, identity.id]);

  const save = useCallback(
    async (changes: { title?: string; content?: string }, useVersion = version) => {
      if (!activeId) return;
      setStatus('saving');
      try {
        const sheet = await api.saveSheet(activeId, changes, useVersion);
        setVersion(sheet.version);
        savedContent.current = sheet.content;
        setStatus('saved');
        setConflict(null);
        void refreshSheets();
      } catch (cause) {
        if (cause instanceof ConflictError) {
          setConflict(cause.current);
          setStatus('error');
          return;
        }
        setError(describe(cause));
        setStatus('error');
      }
    },
    [activeId, version, refreshSheets],
  );

  // Autosave on a debounce, but only while this tab holds the lock and only
  // when the text has actually moved on from what the server has.
  useEffect(() => {
    if (!activeId || !lock.granted || conflict) return;
    if (content === savedContent.current) return;
    setStatus('unsaved');
    const handle = setTimeout(() => void save({ content }), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [content, activeId, lock.granted, conflict, save]);

  const takeOver = async () => {
    if (!activeId) return;
    try {
      const result = await api.acquireLock(activeId, identity.id, identity.name, true);
      await openSheet(activeId);
      setLock({ granted: result.granted, holder: result.lock });
      setStatus('idle');
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const createSheet = async () => {
    try {
      const sheet = await api.createSheet('Untitled');
      await refreshSheets();
      setActiveId(sheet.id);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const renameSheet = async (sheet: SheetSummary) => {
    const next = window.prompt('Rename sheet', sheet.title);
    if (next === null || next.trim() === '' || next === sheet.title) return;
    try {
      await api.saveSheet(sheet.id, { title: next.trim() }, sheet.version);
      if (sheet.id === activeId) {
        const updated = await api.getSheet(sheet.id);
        setTitle(updated.title);
        setVersion(updated.version);
      }
      await refreshSheets();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const deleteSheet = async (sheet: SheetSummary) => {
    if (!window.confirm(`Delete "${sheet.title}"? This cannot be undone.`)) return;
    try {
      await api.deleteSheet(sheet.id);
      const list = await refreshSheets();
      if (sheet.id === activeId) setActiveId(list[0]?.id ?? null);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const commitTitle = async () => {
    const trimmed = title.trim();
    if (!activeId || trimmed === '') return;
    const current = sheets.find((s) => s.id === activeId);
    if (current && current.title === trimmed) return;
    await save({ title: trimmed });
  };

  return (
    <div className="app">
      <header className="topbar">
        <input
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          disabled={!lock.granted}
          aria-label="Sheet title"
        />
        <span className={`status status-${status}`}>{statusLabel(status, lock)}</span>
        {rates && (
          <span className="rates" title={`Exchange rates from ${rates.date}`}>
            {rates.stale ? '⚠ rates ' : 'rates '}
            {rates.date}
          </span>
        )}
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const next = !siNotation;
            setSiNotation(next);
            localStorage.setItem('webcalc.si', next ? 'on' : 'off');
          }}
          title={
            siNotation
              ? 'Large numbers shown as 300k — click to write them out'
              : 'Large numbers written out — click to abbreviate'
          }
        >
          {siNotation ? '300k' : '300,000'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setSidebarOpen((open) => !open)}
          title={sidebarOpen ? 'Hide sheets' : 'Show sheets'}
        >
          ▤
        </button>
      </header>

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {!lock.granted && activeId && (
        <div className="banner">
          <span>
            Read-only — {lock.holder?.clientName ?? 'another browser'} is editing
            this sheet.
          </span>
          <button type="button" onClick={() => void takeOver()}>
            Take over editing
          </button>
        </div>
      )}

      {conflict && (
        <div className="banner banner-warn">
          <span>
            This sheet changed elsewhere while you were editing. Keep which
            version?
          </span>
          <button
            type="button"
            onClick={() => void save({ content }, conflict.version)}
          >
            Keep mine
          </button>
          <button
            type="button"
            onClick={() => {
              setContent(conflict.content);
              setVersion(conflict.version);
              savedContent.current = conflict.content;
              setConflict(null);
              setStatus('idle');
            }}
          >
            Load theirs
          </button>
        </div>
      )}

      <div className="main">
        <Sidebar
          sheets={sheets}
          activeId={activeId}
          open={sidebarOpen}
          onSelect={setActiveId}
          onCreate={() => void createSheet()}
          onRename={(sheet) => void renameSheet(sheet)}
          onDelete={(sheet) => void deleteSheet(sheet)}
        />
        <div className="sheet-pane">
          <div className="sheet-scroll">
            <Editor
              value={content}
              results={results}
              readOnly={!lock.granted}
              onChange={setContent}
            />
          </div>
          {sheetTotal && (
            <div className="total" title="Total of every value line in this sheet">
              <span className="total-label">Total</span>
              <span className="total-value">{sheetTotal}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function statusLabel(
  status: Status,
  lock: { granted: boolean; holder: Lock | null },
): string {
  if (!lock.granted) return 'read-only';
  switch (status) {
    case 'unsaved':
      return 'editing…';
    case 'saving':
      return 'saving…';
    case 'saved':
      return 'saved';
    case 'error':
      return 'not saved';
    default:
      return '';
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
