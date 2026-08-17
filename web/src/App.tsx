import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  clientIdentity,
  ConflictError,
  switchUser,
  type Folder,
  type Lock,
  type Settings,
  type Sheet,
  type SheetSummary,
  type Session,
  type Statistic,
  type User,
  UnauthorizedError,
} from './api';
import { Editor, type EditorHandle } from './Editor';
import { Login } from './Login';
import { Palette } from './Palette';
import { Reference } from './Reference';
import { Sidebar } from './Sidebar';
import { formatShortcut } from './shortcuts';
import { SpaceSettings } from './SpaceSettings';
import { GlobalSettings } from './GlobalSettings';
import { engineOptionsFrom } from './engineOptions';
import { useEngine, useResults } from './useEngine';
import { useTheme } from './useTheme';
import { download, safeFilename, toCsv, toMarkdown, toPlainText } from './export';

type Status = 'idle' | 'unsaved' | 'saving' | 'saved' | 'readonly' | 'error';

const AUTOSAVE_DELAY_MS = 800;
const LOCK_HEARTBEAT_MS = 15_000;
const STATISTICS: Statistic[] = ['total', 'average', 'count', 'median'];

export function App() {
  const browser = useMemo(clientIdentity, []);
  const theme = useTheme();

  /**
   * Whether a password is wanted, and whether this browser has given it.
   *
   * Null until the answer is known, so neither the app nor the password form is
   * flashed on screen before we know which one belongs there.
   */
  const [session, setSession] = useState<Session | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  /** Which space we are working in. Null until the first load settles. */
  const [space, setSpace] = useState<string | null>(null);
  /** Which space the open sheet belongs to — differs after a share link. */
  const [sheetOwner, setSheetOwner] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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
  /** Something worth saying that is not a failure — see removeSpace. */
  const [notice, setNotice] = useState<string | null>(null);
  // Closed by default on a phone, where it would otherwise cover the sheet.
  // The same breakpoint the stylesheet uses to turn it into an overlay.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia('(max-width: 760px)').matches,
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * The line the sheet should be scrolled to, when one was searched for.
   *
   * Held here rather than passed straight to the editor because the sheet it
   * belongs to may not be open yet — see the load effect, which sets this only
   * once that sheet's text is on its way into state.
   */
  const [reveal, setReveal] = useState<number | null>(null);
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  /** Turns the space list into an editable one, rather than a second menu. */
  const [managingSpaces, setManagingSpaces] = useState(false);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  // `?help` opens the reference on load, so it can be linked to directly.
  const [referenceOpen, setReferenceOpen] = useState(
    () => new URLSearchParams(window.location.search).has('help'),
  );

  /**
   * Who the lock reports as holding a sheet.
   *
   * The id carries the space as well as the browser, so switching space on a
   * shared machine hands the lock over properly instead of the next arrival
   * inheriting it. The name is the space, not the browser — "Work is editing
   * this sheet" is the message worth showing, and it is the whole reason the
   * lock banner exists. A space is not necessarily a person: it may be Work,
   * School, or one client of several.
   */
  const currentUserName = users.find((user) => user.id === space)?.name ?? '';

  const identity = useMemo(
    () => ({
      id: space ? `${browser.id}:${space}` : browser.id,
      name: users.find((user) => user.id === space)?.name ?? browser.name,
    }),
    [browser.id, browser.name, space, users],
  );

  const siNotation = settings.largeNumberNotation !== false;
  const statistic = settings.statistic ?? 'total';
  const showTotal = settings.showTotal !== false;
  // Absent means counted, which is what the corner did before this was a choice.
  const countVariables = settings.countVariablesInTotal !== false;

  // Everything the engine is told, derived in one named place — see
  // engineOptions.ts for why that is not a spread written inline here.
  const engineOptions = useMemo(() => engineOptionsFrom(settings), [settings]);

  const { engine, rates, holidays, needRates } = useEngine(engineOptions);
  const results = useResults(engine, content, needRates);
  const summary = useMemo(
    () => engine.summary(results, statistic, { countVariables }),
    [engine, results, statistic, countVariables],
  );

  /** The content the server last confirmed, so we never save a no-op. */
  const savedContent = useRef('');

  /** Lets ⌘F open the sheet's find panel from anywhere in the app. */
  const editorRef = useRef<EditorHandle>(null);

  /**
   * The line a palette result asked for, while its sheet is still loading.
   *
   * A ref rather than state because nothing renders differently for it: it is
   * a note to the load effect, handed on to `reveal` the moment the sheet the
   * line belongs to is the one on screen.
   */
  const pendingLine = useRef<number | null>(null);

  const persistSettings = useCallback(async (changes: Settings) => {
    // Applied locally first so a toggle responds at once, then replaced by what
    // the server says. That second step is not cosmetic: the response carries
    // the resolved globals, and merging only the change would leave the engine
    // running on a stale resolution until the next reload.
    setSettings((current) => ({ ...current, ...changes }));
    const saved = await api.saveSettings(changes).catch(() => undefined);
    if (saved) setSettings(saved);
  }, []);

  const refreshSheets = useCallback(async () => {
    const list = await api.listSheets({
      ...(query && { query }),
      ...(viewingTrash && { trashed: true }),
    });
    setSheets(list);
    return list;
  }, [query, viewingTrash]);

  const openSheet = useCallback(async (id: string) => {
    const sheet = await api.getSheet(id);
    setTitle(sheet.title);
    setContent(sheet.content);
    setVersion(sheet.version);
    setSheetOwner(sheet.owner);
    savedContent.current = sheet.content;
    setConflict(null);
    setStatus('idle');
    return sheet;
  }, []);

  // First load: settings, folders, then whichever sheet a share link asked
  // for, falling back to the one this tab had open.
  useEffect(() => {
    void (async () => {
      // The gate comes first. Everything below would 401 on a locked instance,
      // and a burst of failed requests is a worse way to discover that a
      // password is wanted than simply asking.
      const current = await api
        .session()
        .catch(() => ({ required: false, authenticated: true }) as Session);
      setSession(current);
      if (current.required && !current.authenticated) return;

      const [loaded, folderList, people] = await Promise.all([
        api.settings().catch(() => ({}) as Settings),
        api.listFolders().catch(() => [] as Folder[]),
        api.users().catch(() => ({ users: [] as User[], current: '' })),
      ]);
      setSettings(loaded);
      setFolders(folderList);
      setUsers(people.users);
      setSpace(people.current);

      try {
        const list = await api.listSheets();
        setSheets(list);

        const slug = shareLinkSlug();
        if (slug) {
          // The link is consumed as soon as it is read. The address bar is an
          // input here, never a mirror of state: leaving /s/kitchen-remodel up
          // would start lying the moment the reader opened another sheet.
          window.history.replaceState(null, '', '/');
          const shared = await api.resolveSlug(slug).catch(() => null);
          if (shared) {
            // Opened directly rather than looked up in the list, so a link to
            // a sheet that has since been trashed still lands on that sheet
            // instead of silently opening an unrelated one.
            setActiveId(shared);
            return;
          }
          setError(`That link does not point at a sheet any more (/s/${slug}).`);
        }

        const target =
          list.find((s) => s.id === rememberedSheet(people.current)) ?? list[0];
        if (target) {
          setActiveId(target.id);
          return;
        }
        const created = await api.createSheet('Untitled');
        setSheets(await api.listSheets());
        setActiveId(created.id);
      } catch (cause) {
        // A session that aged out mid-load is not a failure to report; it is a
        // password to ask for again.
        if (cause instanceof UnauthorizedError) {
          setSession({ required: true, authenticated: false });
          return;
        }
        setError(describe(cause));
      }
    })();
  }, []);

  useEffect(() => {
    void refreshSheets().catch(() => undefined);
  }, [refreshSheets]);

  // Remembered per space, so switching spaces does not try to reopen the sheet
  // the previous one had open — it is not in this list, and the fallback would
  // silently land on whatever happened to be first.
  useEffect(() => {
    if (activeId && space) rememberSheet(space, activeId);
  }, [activeId, space]);

  // Load the sheet and try to claim the editing lock whenever the selection
  // changes. The previous sheet's lock is released on the way out.
  //
  // Held until the space is known: taking the lock under the browser's name
  // and then retaking it under the person's would leave a stale holder for a
  // moment, and the other tab would name the wrong editor.
  useEffect(() => {
    if (!activeId || !space) return;
    let cancelled = false;

    void (async () => {
      try {
        await openSheet(activeId);
        if (cancelled) return;
        // Handed over before the lock is asked for, so it lands in the same
        // batch as the text it refers to. Waiting until after would offer the
        // editor a line number while it was still showing the previous sheet.
        const line = pendingLine.current;
        pendingLine.current = null;
        if (line !== null) setReveal(line);

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
  }, [activeId, space, identity.id, identity.name, openSheet]);

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
      const sheet = await api.createSheet('Untitled');
      await refreshSheets();
      setViewingTrash(false);
      setActiveId(sheet.id);
    } catch (cause) {
      setError(describe(cause));
    }
  }, [refreshSheets]);

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

      /*
       * The three scopes searching has, and the two keys they live behind.
       *
       * ⌘F is find and replace in the sheet in front of you, which is what the
       * key means in every other document. The other two — a sheet by name,
       * and text in any sheet — share one list behind ⌘K, because the answer
       * to either question regularly turns out to be the other one: you go
       * looking for the sheet called Kitchen and find the line that says
       * kitchen instead. ⌘⇧F opens the same list, for the hand that reaches
       * for a shifted find rather than for a palette.
       */
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'f') {
        // Inside the sheet CodeMirror's own keymap has already opened the
        // panel and marked the event; this is the path from everywhere else,
        // so ⌘F means the same thing wherever the caret happens to be.
        if (!event.defaultPrevented) {
          event.preventDefault();
          setPaletteOpen(false);
          editorRef.current?.openSearch();
        }
      }
      if (
        mod &&
        (event.key.toLowerCase() === 'k' ||
          (event.shiftKey && event.key.toLowerCase() === 'f'))
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }

      if (event.key === 'Escape') {
        setExportOpen(false);
        setReferenceOpen(false);
        setPaletteOpen(false);
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

  const addSpace = async () => {
    const name = window.prompt('Name for the new space');
    if (name === null || name.trim() === '') return;
    try {
      const created = await api.createSpace(name.trim());
      setUsers((current) => [...current, created]);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  /** Applies a name the caller has already settled on. */
  const applySpaceName = async (user: User, name: string) => {
    if (name === '' || name === user.name) return;
    try {
      const renamed = await api.renameSpace(user.id, name);
      setUsers((current) =>
        current.map((entry) => (entry.id === user.id ? renamed : entry)),
      );
    } catch (cause) {
      setError(describe(cause));
    }
  };

  /** The switcher's rename, which has to ask for the name first. */
  const renameSpace = async (user: User) => {
    const next = window.prompt('Rename space', user.name);
    if (next === null) return;
    await applySpaceName(user, next.trim());
  };

  /**
   * Removes a space after saying plainly what happens to its sheets.
   *
   * They are kept, not deleted, and adding the space back under the same name
   * brings them into view again — so both the confirmation and what follows
   * say that, rather than the usual "cannot be undone", which would be untrue
   * and would make this feel more dangerous than it is.
   *
   * How much is affected is only known server-side: the sheet list here holds
   * the current space's sheets and nobody else's, so the count comes back with
   * the deletion rather than being guessed at beforehand.
   */
  const removeSpace = async (user: User) => {
    const warning =
      `Remove the space “${user.name}”? Any sheets in it are kept, but stay ` +
      `hidden until a space is added back under the same name.`;
    if (!window.confirm(warning)) return;
    try {
      const { hidden } = await api.deleteSpace(user.id);
      if (hidden > 0) {
        setNotice(
          `“${user.name}” is gone from the switcher. ${hidden} ${
            hidden === 1 ? 'sheet or folder is' : 'sheets and folders are'
          } still stored, and adding “${user.name}” back will show them again.`,
        );
      }
      if (user.id === space) {
        // Staying on a space that no longer exists would show someone else's
        // sheets under this person's name until the next reload.
        window.location.reload();
        return;
      }
      setUsers((current) => current.filter((entry) => entry.id !== user.id));
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

  /**
   * Mints a link to this sheet and offers it for copying.
   *
   * This is the only place a sheet identifier reaches the address bar, and
   * only ever the recipient's. A pending rename is flushed first so the link
   * is named from the title on screen rather than the one the server last saw.
   */
  const shareSheet = async () => {
    if (!activeId) return;
    try {
      const trimmed = title.trim();
      if (trimmed && trimmed !== sheets.find((s) => s.id === activeId)?.title) {
        await save({ title: trimmed });
      }
      const { slug } = await api.shareSheet(activeId);
      const url = `${window.location.origin}/s/${slug}`;
      setShare({ url, copied: await copyToClipboard(url) });
    } catch (cause) {
      setError(describe(cause));
    }
  };

  /** On a phone the sidebar is an overlay, so acting on it should dismiss it. */
  const closeSidebarOnPhone = () => {
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
  };

  const cycleStatistic = () => {
    const next = STATISTICS[(STATISTICS.indexOf(statistic) + 1) % STATISTICS.length]!;
    void persistSettings({ statistic: next });
  };

  // Nothing decided yet: neither the app nor the form is the right thing to show.
  if (session === null) return null;

  // A reload rather than re-running the loader, for the same reason switching
  // space reloads: signing in changes what every request returns, and starting
  // clean is more trustworthy than unwinding a half-loaded app.
  if (session.required && !session.authenticated) {
    return <Login onSignedIn={() => window.location.reload()} />;
  }

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
        {/* A sheet reached by share link is not in this sidebar, so say whose
            it is rather than leaving it looking like a sheet that went
            missing from the list. */}
        {sheetOwner && space && sheetOwner !== space && (
          <span className="owner-badge">
            From {users.find((user) => user.id === sheetOwner)?.name ?? sheetOwner}
          </span>
        )}
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
        <div className="menu-anchor">
          <button
            type="button"
            className="ghost"
            onClick={() => (share ? setShare(null) : void shareSheet())}
            title="Copy a link to this sheet"
            aria-label="Copy a link to this sheet"
            disabled={!activeId}
          >
            🔗
          </button>
          {share && (
            <>
              <div className="menu-backdrop" onClick={() => setShare(null)} />
              <div className="answer-menu share-menu">
                <input
                  className="share-link"
                  value={share.url}
                  readOnly
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Link to this sheet"
                />
                <p className="share-hint">
                  {share.copied
                    ? 'Copied. The link keeps working if you rename the sheet.'
                    : `Press ${formatShortcut(['Mod', 'C'])} to copy. The link keeps ` +
                      'working if you rename the sheet.'}
                </p>
              </div>
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
          aria-pressed={countVariables}
          onClick={() => void persistSettings({ countVariablesInTotal: !countVariables })}
          title={
            countVariables
              ? 'Variable lines count towards the figure — click to leave them out'
              : 'Variable lines are left out of the figure — click to count them'
          }
        >
          {countVariables ? '+x=' : '−x='}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setSidebarOpen((open) => !open)}
          title={sidebarOpen ? 'Hide sheets' : 'Show sheets'}
        >
          ▤
        </button>
        {/* Shown even for one person, since this is where a second is added. */}
        {users.length > 0 && (
          <div className="menu-anchor">
            <button
              type="button"
              className="user-chip"
              onClick={() => setUserMenuOpen((open) => !open)}
              title={`In the ${currentUserName} space — click to switch`}
              aria-label={`In the ${currentUserName} space. Switch or manage spaces.`}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              {currentUserName.charAt(0)}
            </button>
            {userMenuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onClick={() => {
                    setUserMenuOpen(false);
                    setManagingSpaces(false);
                  }}
                />
                <ul className="answer-menu user-menu" role="menu">
                  {users.map((user) => (
                    <li key={user.id} className={managingSpaces ? 'space-row' : undefined}>
                      <button
                        type="button"
                        role={managingSpaces ? 'menuitem' : 'menuitemradio'}
                        {...(managingSpaces ? {} : { 'aria-checked': user.id === space })}
                        disabled={managingSpaces}
                        onClick={() => {
                          setUserMenuOpen(false);
                          if (user.id === space) return;
                          switchUser(user.id);
                          // A reload rather than a re-fetch: the space changes
                          // the sheets, the folders, the settings and the lock
                          // identity at once, and starting clean is more
                          // trustworthy than unwinding all of it.
                          window.location.reload();
                        }}
                      >
                        <span className="tick">
                          {!managingSpaces && user.id === space ? '✓' : ''}
                        </span>
                        {user.name}
                      </button>
                      {managingSpaces && (
                        <span className="space-actions">
                          <button
                            type="button"
                            className="ghost"
                            title={`Rename ${user.name}`}
                            aria-label={`Rename ${user.name}`}
                            onClick={() => void renameSpace(user)}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            title={
                              users.length > 1
                                ? `Remove ${user.name}`
                                : 'The last space cannot be removed'
                            }
                            aria-label={`Remove ${user.name}`}
                            disabled={users.length <= 1}
                            onClick={() => void removeSpace(user)}
                          >
                            ✕
                          </button>
                        </span>
                      )}
                    </li>
                  ))}

                  <li className="menu-separator" role="separator" />

                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setManagingSpaces(false);
                        setSpaceSettingsOpen(true);
                      }}
                    >
                      <span className="tick" />
                      {currentUserName || "Space"} settings…
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setManagingSpaces(false);
                        setGlobalSettingsOpen(true);
                      }}
                    >
                      <span className="tick" />
                      Global settings…
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setManagingSpaces(false);
                        void addSpace();
                      }}
                    >
                      <span className="tick" />
                      Add space…
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setManagingSpaces((managing) => !managing)}
                    >
                      <span className="tick" />
                      {managingSpaces ? 'Done' : 'Rename or remove…'}
                    </button>
                  </li>
                  {/* Only on an instance that asked for a password — elsewhere
                      there is nothing to sign out of. */}
                  {session.required && (
                    <>
                      <li className="menu-separator" role="separator" />
                      <li>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            void api
                              .signOut()
                              .catch(() => undefined)
                              .then(() => window.location.reload());
                          }}
                        >
                          <span className="tick" />
                          Sign out
                        </button>
                      </li>
                    </>
                  )}
                </ul>
              </>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div className="banner">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
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
        {sidebarOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        <Sidebar
          sheets={sheets}
          folders={folders}
          activeId={activeId}
          query={query}
          viewingTrash={viewingTrash}
          open={sidebarOpen}
          onSelect={(id) => {
            setViewingTrash(false);
            setActiveId(id);
            closeSidebarOnPhone();
          }}
          onCreate={() => {
            void createSheet();
            closeSidebarOnPhone();
          }}
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
              .then(setFolders)
              .catch((cause: unknown) => setError(describe(cause)));
          }}
          onColorSheet={(sheet, color) => {
            // Painted immediately and reconciled after, because a colour is
            // chosen by eye: waiting a round trip to see the result makes
            // picking through the palette feel broken.
            setSheets((current) =>
              current.map((entry) =>
                entry.id === sheet.id ? { ...entry, color } : entry,
              ),
            );
            void api
              .setSheetColor(sheet.id, color)
              .then(() => refreshSheets())
              .catch((cause: unknown) => {
                setError(describe(cause));
                void refreshSheets();
              });
          }}
          onColorFolder={(folder, color) => {
            setFolders((current) =>
              current.map((entry) =>
                entry.id === folder.id ? { ...entry, color } : entry,
              ),
            );
            void api
              .setFolderColor(folder.id, color)
              .then(() => api.listFolders())
              .then(setFolders)
              .catch((cause: unknown) => {
                setError(describe(cause));
                void api.listFolders().then(setFolders);
              });
          }}
          manualOrder={settings.sheetOrder === 'manual'}
          onReorder={(ids) => {
            // Painted first so the row lands where it was dropped rather than
            // springing back for the length of a round trip.
            setSheets((current) => {
              const byId = new Map(current.map((sheet) => [sheet.id, sheet]));
              return ids.map((id) => byId.get(id)).filter((s) => s !== undefined);
            });
            // The setting is changed by the server as part of the reorder; this
            // keeps the local copy from lagging a render behind it.
            setSettings((current) => ({ ...current, sheetOrder: 'manual' }));
            void api
              .reorderSheets(ids)
              .then(() => refreshSheets())
              .catch((cause: unknown) => {
                setError(describe(cause));
                void refreshSheets();
              });
          }}
          onSortByRecent={() => {
            // The positions are left alone, so flipping to recent to find
            // something and back again does not cost the arrangement.
            void persistSettings({ sheetOrder: 'recent' }).then(() => refreshSheets());
          }}
          onToggleTrash={() => setViewingTrash((viewing) => !viewing)}
          onEmptyTrash={() => {
            if (!window.confirm('Permanently delete everything in the trash?')) return;
            void api.emptyTrash().then(() => refreshSheets());
          }}
        />
        <div className="sheet-pane">
          <div className="sheet-scroll">
            <Editor
              ref={editorRef}
              value={content}
              results={results}
              readOnly={!lock.granted}
              reveal={reveal}
              onChange={setContent}
              onRevealed={() => setReveal(null)}
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

      {space && (
        <SpaceSettings
          open={spaceSettingsOpen}
          space={{ id: space, name: currentUserName || space }}
          globals={settings.globals ?? {}}
          sharedGlobals={settings.sharedGlobals ?? {}}
          canRemove={users.length > 1}
          computed={{
            ...(settings.region && { region: settings.region }),
            ...(settings.zone && { zone: settings.zone }),
          }}
          sharedComputed={settings.shared ?? {}}
          // One line through the same engine the sheets use, so the preview
          // cannot disagree with what a sheet would actually compute.
          preview={(expression) => engine.evaluate(expression)[0]?.output ?? ''}
          onRename={(next) => {
            const current = users.find((user) => user.id === space);
            if (current) void applySpaceName(current, next);
          }}
          onSaveGlobals={(globals) => void persistSettings({ globals })}
          onSaveComputed={(key, value) => void persistSettings({ [key]: value })}
          onRemove={() => {
            const current = users.find((user) => user.id === space);
            if (!current) return;
            setSpaceSettingsOpen(false);
            void removeSpace(current);
          }}
          onClose={() => setSpaceSettingsOpen(false)}
        />
      )}

      <GlobalSettings
        open={globalSettingsOpen}
        computed={settings.shared ?? {}}
        globals={settings.sharedGlobals ?? {}}
        preview={(expression) => engine.evaluate(expression)[0]?.output ?? ''}
        onSaveComputed={(key, value) => {
          // Refetched rather than merged: the server owns the resolved view, and
          // a space that overrides this must not appear to have picked it up.
          void api
            .saveSharedComputed(key, value)
            .then(() => api.settings())
            .then(setSettings)
            .catch((cause: unknown) => setError(describe(cause)));
        }}
        onSaveGlobals={(globals) => {
          void api
            .saveSharedGlobals(globals)
            .then(() => api.settings())
            .then(setSettings)
            .catch((cause: unknown) => setError(describe(cause)));
        }}
        onClose={() => setGlobalSettingsOpen(false)}
      />

      <Palette
        open={paletteOpen}
        recent={sheets}
        onClose={() => setPaletteOpen(false)}
        onOpen={(id, line) => {
          closeSidebarOnPhone();
          // Results are never trashed sheets, so a list that was showing the
          // trash has to come back to the live one to hold what was chosen.
          setViewingTrash(false);
          if (id === activeId) {
            setReveal(line);
            return;
          }
          pendingLine.current = line;
          setActiveId(id);
        }}
      />

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

const lastSheetKey = (space: string) => `webcalc.lastSheet.${space}`;

/**
 * Remembers the open sheet without putting it in the address bar.
 *
 * Both stores are written because they answer different questions.
 * sessionStorage is per-tab, so two tabs left on different sheets each return
 * to their own after a refresh — something a single URL could not express.
 * localStorage covers the case sessionStorage cannot: a brand-new tab, or the
 * browser reopened from cold. The key carries the space, so the two people
 * sharing a machine do not overwrite each other's place.
 */
function rememberSheet(space: string, id: string): void {
  try {
    sessionStorage.setItem(lastSheetKey(space), id);
    localStorage.setItem(lastSheetKey(space), id);
  } catch {
    // Storage can be refused outright in private mode. Losing the restore is
    // not worth failing the sheet switch over.
  }
}

function rememberedSheet(space: string): string | null {
  try {
    const key = lastSheetKey(space);
    return sessionStorage.getItem(key) ?? localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The slug from a `/s/<slug>` share link, when the app was opened by one. */
function shareLinkSlug(): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Copies text, reporting whether it worked.
 *
 * `navigator.clipboard` exists only in a secure context, so on an instance
 * reached as http://host:port it is undefined — the same restriction that
 * shapes the client id in api.ts. The caller shows the link either way, so a
 * failed copy costs a keystroke rather than the whole feature.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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
