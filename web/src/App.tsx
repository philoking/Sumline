import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  clientIdentity,
  ConflictError,
  type Folder,
  type Lock,
  type Settings,
  type Sheet,
  type SheetSummary,
  type Statistic,
} from './api';
import { Editor } from './Editor';
import { Reference } from './Reference';
import { Sidebar } from './Sidebar';
import { useEngine, useResults } from './useEngine';
import { useTheme } from './useTheme';
import { download, safeFilename, toCsv, toMarkdown, toPlainText } from './export';

type Status = 'idle' | 'unsaved' | 'saving' | 'saved' | 'readonly' | 'error';

const AUTOSAVE_DELAY_MS = 800;
const LOCK_HEARTBEAT_MS = 15_000;
const STATISTICS: Statistic[] = ['total', 'average', 'count', 'median'];

export function App() {
  const identity = useMemo(clientIdentity, []);
  const theme = useTheme();

  const [settings, setSettings] = useState<Settings>({});
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [viewingTrash, setViewingTrash] = useState(false);
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
  const [exportOpen, setExportOpen] = useState(false);
  // `?help` opens the reference on load, so it can be linked to directly.
  const [referenceOpen, setReferenceOpen] = useState(
    () => new URLSearchParams(window.location.search).has('help'),
  );

  const siNotation = settings.largeNumberNotation !== false;
  const statistic = settings.statistic ?? 'total';
  const showTotal = settings.showTotal !== false;

  const { engine, rates, holidays } = useEngine({
    largeNumberNotation: siNotation,
    ...(settings.globals && { globals: settings.globals }),
  });
  const results = useResults(engine, content);
  const summary = useMemo(
    () => engine.summary(results, statistic),
    [engine, results, statistic],
  );

  /** The content the server last confirmed, so we never save a no-op. */
  const savedContent = useRef('');

  const persistSettings = useCallback(async (changes: Settings) => {
    setSettings((current) => ({ ...current, ...changes }));
    await api.saveSettings(changes).catch(() => undefined);
  }, []);

  const refreshSheets = useCallback(async () => {
    const list = await api.listSheets({
      ...(activeFolder !== undefined && { folderId: activeFolder }),
      ...(query && { query }),
      ...(viewingTrash && { trashed: true }),
    });
    setSheets(list);
    return list;
  }, [activeFolder, query, viewingTrash]);

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

  // First load: settings, folders, then the sheet named in the URL.
  useEffect(() => {
    void (async () => {
      const [loaded, folderList] = await Promise.all([
        api.settings().catch(() => ({}) as Settings),
        api.listFolders().catch(() => [] as Folder[]),
      ]);
      setSettings(loaded);
      setFolders(folderList);

      try {
        const list = await api.listSheets();
        setSheets(list);
        const fromUrl = window.location.hash.replace(/^#\/?/, '');
        const target = list.find((s) => s.id === fromUrl) ?? list[0];
        if (target) {
          setActiveId(target.id);
          return;
        }
        const created = await api.createSheet('Untitled');
        setSheets(await api.listSheets());
        setActiveId(created.id);
      } catch (cause) {
        setError(describe(cause));
      }
    })();
  }, []);

  useEffect(() => {
    void refreshSheets().catch(() => undefined);
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
      void api.releaseLock(releasing, identity.id).catch(() => undefined);
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
    async (
      changes: { title?: string; content?: string; folderId?: string | null },
      useVersion = version,
    ) => {
      if (!activeId) return;
      setStatus('saving');
      try {
        const sheet = await api.saveSheet(activeId, changes, useVersion);
        setVersion(sheet.version);
        savedContent.current = sheet.content;
        setTitle(sheet.title);
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

  useEffect(() => {
    if (!activeId || !lock.granted || conflict) return;
    if (content === savedContent.current) return;
    setStatus('unsaved');
    const handle = setTimeout(() => void save({ content }), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [content, activeId, lock.granted, conflict, save]);

  const createSheet = useCallback(async () => {
    try {
      const sheet = await api.createSheet('Untitled', '', activeFolder ?? null);
      await refreshSheets();
      setViewingTrash(false);
      setActiveId(sheet.id);
    } catch (cause) {
      setError(describe(cause));
    }
  }, [activeFolder, refreshSheets]);

  // App-level shortcuts. The editor owns everything that edits text.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'n' && event.shiftKey) {
        event.preventDefault();
        void createSheet();
      }
      // Autosave already handles persistence; this only stops the browser
      // offering to save the page.
      if (mod && event.key.toLowerCase() === 's') event.preventDefault();
      if (mod && event.key.toLowerCase() === 'f') {
        const search = document.querySelector<HTMLInputElement>('.sidebar-search input');
        if (search) {
          event.preventDefault();
          setSidebarOpen(true);
          search.focus();
        }
      }
      if (event.key === 'Escape') {
        setExportOpen(false);
        setReferenceOpen(false);
      }
      // `?` opens the reference, but not while a field or the sheet has focus.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.closest('input, textarea, .cm-editor, [contenteditable]') !== null;
      if (event.key === '?' && !typing) {
        event.preventDefault();
        setReferenceOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createSheet]);

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

  const renameSheet = async (sheet: SheetSummary) => {
    const next = window.prompt('Rename sheet', sheet.title);
    if (next === null || next.trim() === '' || next === sheet.title) return;
    try {
      await api.saveSheet(sheet.id, { title: next.trim() }, sheet.version);
      if (sheet.id === activeId) await openSheet(sheet.id);
      await refreshSheets();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const deleteSheet = async (sheet: SheetSummary) => {
    const permanent = viewingTrash;
    if (
      permanent &&
      !window.confirm(`Permanently delete "${sheet.title}"? This cannot be undone.`)
    ) {
      return;
    }
    try {
      await api.deleteSheet(sheet.id, permanent);
      const list = await refreshSheets();
      if (sheet.id === activeId) setActiveId(list[0]?.id ?? null);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const exportAs = (kind: 'text' | 'markdown' | 'csv' | 'clipboard') => {
    const options = { title, content, results };
    setExportOpen(false);
    if (kind === 'clipboard') {
      void navigator.clipboard?.writeText(toPlainText(options));
      return;
    }
    if (kind === 'text') {
      download(safeFilename(title, 'txt'), toPlainText(options), 'text/plain');
    } else if (kind === 'markdown') {
      download(safeFilename(title, 'md'), toMarkdown(options), 'text/markdown');
    } else {
      download(safeFilename(title, 'csv'), toCsv(options), 'text/csv');
    }
  };

  const cycleStatistic = () => {
    const next = STATISTICS[(STATISTICS.indexOf(statistic) + 1) % STATISTICS.length]!;
    void persistSettings({ statistic: next });
  };

  return (
    <div className="app">
      <header className="topbar">
        <input
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const trimmed = title.trim();
            if (trimmed && trimmed !== sheets.find((s) => s.id === activeId)?.title) {
              void save({ title: trimmed });
            }
          }}
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
        <div className="menu-anchor">
          <button
            type="button"
            className="ghost"
            onClick={() => setExportOpen((open) => !open)}
            title="Export this sheet"
          >
            ⤓
          </button>
          {exportOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setExportOpen(false)} />
              <ul className="answer-menu export-menu">
                <li>
                  <button type="button" onClick={() => exportAs('clipboard')}>
                    Copy with answers
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => exportAs('text')}>
                    Download as text
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => exportAs('markdown')}>
                    Download as Markdown
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => exportAs('csv')}>
                    Download as CSV
                  </button>
                </li>
                <li className="menu-separator" />
                <li>
                  <button type="button" onClick={() => window.print()}>
                    Print / save as PDF
                  </button>
                </li>
              </ul>
            </>
          )}
        </div>
        <button
          type="button"
          className="ghost"
          onClick={theme.cycle}
          title={theme.label}
          aria-label={theme.label}
        >
          {theme.icon}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setReferenceOpen((open) => !open)}
          title="What can I type? (?)"
        >
          ?
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void persistSettings({ largeNumberNotation: !siNotation })}
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

      {!lock.granted && activeId && !viewingTrash && (
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
          <button type="button" onClick={() => void save({ content }, conflict.version)}>
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
          folders={folders}
          activeId={activeId}
          activeFolder={activeFolder}
          query={query}
          viewingTrash={viewingTrash}
          open={sidebarOpen}
          onSelect={(id) => {
            setViewingTrash(false);
            setActiveId(id);
          }}
          onCreate={() => void createSheet()}
          onRename={(sheet) => void renameSheet(sheet)}
          onDelete={(sheet) => void deleteSheet(sheet)}
          onRestore={(sheet) => {
            void api.restoreSheet(sheet.id).then(() => refreshSheets());
          }}
          onMove={(sheet, folderId) => {
            void api
              .saveSheet(sheet.id, { folderId }, sheet.version)
              .then(() => refreshSheets())
              .catch((cause: unknown) => setError(describe(cause)));
          }}
          onQuery={setQuery}
          onSelectFolder={(folderId) => {
            setViewingTrash(false);
            setActiveFolder(folderId);
          }}
          onCreateFolder={() => {
            const name = window.prompt('Folder name');
            if (!name?.trim()) return;
            void api
              .createFolder(name.trim())
              .then(() => api.listFolders())
              .then(setFolders)
              .catch((cause: unknown) => setError(describe(cause)));
          }}
          onRenameFolder={(folder) => {
            const name = window.prompt('Rename folder', folder.name);
            if (!name?.trim()) return;
            void api
              .renameFolder(folder.id, name.trim())
              .then(() => api.listFolders())
              .then(setFolders)
              .catch((cause: unknown) => setError(describe(cause)));
          }}
          onDeleteFolder={(folder) => {
            if (!window.confirm(`Delete "${folder.name}"? Its sheets are kept.`)) return;
            void api
              .deleteFolder(folder.id)
              .then(() => api.listFolders())
              .then((list) => {
                setFolders(list);
                setActiveFolder(undefined);
              })
              .catch((cause: unknown) => setError(describe(cause)));
          }}
          onToggleTrash={() => {
            setViewingTrash((viewing) => !viewing);
            setActiveFolder(undefined);
          }}
          onEmptyTrash={() => {
            if (!window.confirm('Permanently delete everything in the trash?')) return;
            void api.emptyTrash().then(() => refreshSheets());
          }}
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
          {showTotal && summary && (
            <div className="total">
              <button
                type="button"
                className="total-label"
                onClick={cycleStatistic}
                title="Click to change the statistic"
              >
                {statistic === 'total' ? 'Total' : capitalise(statistic)}
              </button>
              <span className="total-value">{summary}</span>
              <button
                type="button"
                className="total-hide"
                onClick={() => void persistSettings({ showTotal: false })}
                title="Hide the total"
              >
                ×
              </button>
            </div>
          )}
          {!showTotal && (
            <button
              type="button"
              className="total total-restore"
              onClick={() => void persistSettings({ showTotal: true })}
            >
              Show total
            </button>
          )}
        </div>
      </div>

      <Reference
        open={referenceOpen}
        currencies={engine.currencies}
        rateDate={engine.rateDate}
        holidayCount={holidays?.dates.length ?? 0}
        onClose={() => setReferenceOpen(false)}
        onInsert={(line) => {
          // Appended rather than inserted at the cursor: the panel has focus,
          // so there is no meaningful caret position in the sheet to use.
          setContent((current) => {
            const needsBreak = current !== '' && !current.endsWith('\n');
            return `${current}${needsBreak ? '\n' : ''}${line}\n`;
          });
        }}
      />
    </div>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
