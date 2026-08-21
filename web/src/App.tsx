import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  api,
  clientIdentity,
  type Folder,
  type Lock,
  type Settings,
  type SheetSummary,
  type Session,
  type Statistic,
  type User,
  UnauthorizedError,
} from './api';
import { Conflict } from './Conflict';
import { Editor, type EditorHandle } from './Editor';
import { Login } from './Login';
import { Palette } from './Palette';
import { Reference } from './Reference';
import { Sidebar } from './Sidebar';
import { Banners } from './Banners';
import { TopBar } from './TopBar';
import { DEFAULT_PRECISION, engineOptionsFrom } from '@sumline/engine';
import { DEFAULT_FONT_SIZE, FONT_STEP, clampFontSize } from './ViewMenu';
import { SpaceSettings } from './SpaceSettings';
import { GlobalSettings } from './GlobalSettings';
import { useEngine, useResults } from './useEngine';

/**
 * The empty set of globals, as one object rather than a new one per render.
 *
 * `settings.globals ?? {}` minted a fresh identity every time App rendered,
 * and the settings panel resets its rows when that prop changes. Sheet text
 * lives at this root, so "every time App rendered" is every keystroke and
 * every event off the stream: a variable being typed was wiped mid-entry, row
 * and all. It only bit while `settings.globals` was undefined, which is to say
 * only for somebody who had never set one, so it hit first use exclusively.
 */
const NO_GLOBALS: Record<string, string> = Object.freeze({});
import { useLive, type LiveEvent } from './live';
import { useTheme } from './useTheme';
import { useSheetLock } from './useSheetLock';
import { useActiveSheet, type Status } from './useActiveSheet';
import { useSheetList } from './useSheetList';
import { useSpaces } from './useSpaces';
import { useAsk } from './Ask';
import { download, safeFilename, toCsv, toMarkdown, toPlainText } from './export';

/**
 * How long the app waits before acting on a change the server announced.
 *
 * Long enough that a burst — someone typing, whose sheet autosaves about once a
 * second — costs one refetch of the list rather than one per save, and short
 * enough that a rename in another browser lands while you are still looking at
 * the row it changed.
 */
const LIVE_SETTLE_MS = 400;

/**
 * How often the app asks, when the event stream is not answering.
 *
 * Slower than the stream is instant, and slower than the lock heartbeat, on the
 * grounds that this is the degraded path: a proxy buffering the stream should
 * cost freshness rather than the feature. Sheets still refresh on every action
 * this browser takes, exactly as they did before any of this existed.
 */
const FALLBACK_POLL_MS = 30_000;

const STATISTICS: Statistic[] = ['total', 'average', 'count', 'median'];

export function App() {
  const browser = useMemo(() => clientIdentity(), []);
  const theme = useTheme();

  /**
   * Whether a password is wanted, and whether this browser has given it.
   *
   * Null until the answer is known, so neither the app nor the password form is
   * flashed on screen before we know which one belongs there.
   */
  const [session, setSession] = useState<Session | null>(null);
  /** Which space we are working in. Null until the first load settles. */
  /** Which space the open sheet belongs to — differs after a share link. */
  const [settings, setSettings] = useState<Settings>({});

  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [viewingTrash, setViewingTrash] = useState(false);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  /** Something worth saying that is not a failure — see removeSpace. */
  const [notice, setNotice] = useState<string | null>(null);

  // Every naming and confirmation step in the app. See Ask.tsx for why these
  // are not `window.prompt` and `window.confirm` any more.
  const ask = useAsk();

  const {
    users,
    space,
    setUsers,
    setSpace,
    currentName: currentUserName,
    add: addSpaceNamed,
    rename: applySpaceName,
    remove: removeSpaceConfirmed,
  } = useSpaces({
    onError: (cause) => setError(describe(cause)),
    onNotice: setNotice,
  });

  // Closed by default on a phone, where it would otherwise cover the sheet.
  // The same breakpoint the stylesheet uses to turn it into an overlay.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia('(max-width: 760px)').matches,
  );
  /**
   * The line the sheet should be scrolled to, when one was searched for.
   *
   * Held here rather than passed straight to the editor because the sheet it
   * belongs to may not be open yet — see the load effect, which sets this only
   * once that sheet's text is on its way into state.
   */
  const [reveal, setReveal] = useState<number | null>(null);

  /**
   * Which panel is over the app, if any.
   *
   * One value rather than four booleans, because only one of these can
   * sensibly be on screen at a time and four independent flags did not say so:
   * opening the reference while space settings was open left both mounted, one
   * on top of the other. Naming the state after the question it answers makes
   * that impossible rather than merely unlikely.
   *
   * `?help` opens the reference on load, so it can be linked to directly.
   */
  const [overlay, setOverlay] = useState<
    'palette' | 'reference' | 'space-settings' | 'global-settings' | null
  >(() => (new URLSearchParams(window.location.search).has('help') ? 'reference' : null));
  const toggleOverlay = useCallback(
    (which: 'palette' | 'reference' | 'space-settings' | 'global-settings') =>
      setOverlay((current) => (current === which ? null : which)),
    [],
  );
  const closeOverlay = useCallback(() => setOverlay(null), []);

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
  const identity = useMemo(
    () => ({
      id: space ? `${browser.id}:${space}` : browser.id,
      name: users.find((user) => user.id === space)?.name ?? browser.name,
    }),
    [browser.id, browser.name, space, users],
  );

  /**
   * What each announcement from the server means, filled in further down.
   *
   * A ring to break: `useLive` needs a handler, the handler needs to know
   * whether this browser holds the lock, and the lock needs to know whether the
   * stream is flowing. This is the cheapest place to cut it — `useLive` already
   * keeps its handler in a ref and calls it only when an event arrives, which
   * is long after the render that filled this in.
   */
  const onLive = useRef<(event: LiveEvent) => void>(() => {});

  // Not opened until the gate is settled and passed: on a locked instance the
  // stream is one more request to 401, and it is the one request that would
  // retry forever.
  const live = useLive(
    session !== null && (!session.required || session.authenticated),
    useCallback((event: LiveEvent) => onLive.current(event), []),
  );

  const {
    lock,
    claim: claimLock,
    release: releaseLock,
    applyHolder,
  } = useSheetLock({ activeId, identity, live, onStatus: setStatus });

  const siNotation = settings.largeNumberNotation !== false;
  const statistic = settings.statistic ?? 'total';
  const showTotal = settings.showTotal !== false;
  // Absent means counted, which is what the corner did before this was a choice
  // — and what Soulver's own Total Options ship ticked.
  const countVariables = settings.countVariablesInTotal !== false;
  const countReferenced = settings.countReferencedInTotal !== false;
  const showLineNumbers = settings.showLineNumbers !== false;
  const fontSize = clampFontSize(settings.sheetFontSize ?? DEFAULT_FONT_SIZE);
  const thousandsSeparators = settings.thousandsSeparators !== false;
  const currencyRounding = settings.currencyRounding !== false;
  // The engine clamps this too; here it only decides which button looks picked.
  const precision = settings.precision ?? DEFAULT_PRECISION;

  const {
    sheets,
    folders,
    refresh: refreshSheets,
    refreshFolders,
    setSheets,
    setFolders,
    restore: restoreSheet,
    move: moveSheet,
    createFolder,
    renameFolder,
    deleteFolder,
    colorSheet,
    colorFolder,
    reorder: reorderSheets,
  } = useSheetList({
    query,
    viewingTrash,
    onError: (cause) => setError(describe(cause)),
    onManualOrder: () => setSettings((current) => ({ ...current, sheetOrder: 'manual' })),
  });

  const {
    title,
    setTitle,
    content,
    setContent,
    sheetOwner,
    conflict,
    savedContent,
    open: openSheet,
    save,
    keepBoth,
    takeTheirs,
  } = useActiveSheet({
    activeId,
    canEdit: lock.granted,
    refreshSheets,
    folderOf: (id) => sheets.find((sheet) => sheet.id === id)?.folderId ?? null,
    onStatus: setStatus,
    onError: (cause) => setError(describe(cause)),
    onNotice: setNotice,
  });

  // Everything the engine is told, derived in one named place — see
  // engineOptions.ts for why that is not a spread written inline here.
  const engineOptions = useMemo(() => engineOptionsFrom(settings), [settings]);

  const { engine, rates, holidays, needRates, refreshRates } = useEngine(engineOptions);
  const results = useResults(engine, content, needRates);
  const summary = useMemo(
    () => engine.summary(results, statistic, { countVariables, countReferenced }),
    [engine, results, statistic, countVariables, countReferenced],
  );

  /**
   * The figure for a run of selected lines.
   *
   * Runs through the same `summary` call the corner uses, with the same
   * statistic and the same rule about variable lines, so selecting the whole
   * sheet gives the number already in the corner rather than a second opinion
   * about what "the figure" means.
   */
  const summariseLines = useCallback(
    (from: number, to: number) => {
      const value = engine.summary(results.slice(from - 1, to), statistic, {
        countVariables,
        countReferenced,
      });
      if (!value) return null;
      return {
        label: statistic === 'total' ? 'Total' : capitalise(statistic),
        value,
      };
    },
    [engine, results, statistic, countVariables, countReferenced],
  );

  /**
   * How the sheet is coloured.
   *
   * The same engine that answers the sheet, so the colouring cannot claim a
   * word means something the answer disagrees with. Memoised on the engine
   * alone: it depends on nothing else, and a new identity every render would
   * have the editor re-read the whole sheet each time anything else moved.
   */
  const tokenizeSheet = useCallback(
    (source: string) => engine.tokenize(source),
    [engine],
  );

  /** The content the server last confirmed, so we never save a no-op. */

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

        await claimLock(activeId);
      } catch (cause) {
        if (!cancelled) setError(describe(cause));
      }
    })();

    const releasing = activeId;
    return () => {
      cancelled = true;
      releaseLock(releasing);
    };
  }, [activeId, space, openSheet, claimLock, releaseLock]);

  /**
   * Which sheet is open, readable from a callback that has already resolved.
   *
   * The live handlers below start requests and act on what comes back, by which
   * time the selection may have moved on — and applying an answer about the
   * previous sheet to the current one is worse than not answering at all.
   */
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  /**
   * Refetches the sidebar, coalescing a burst into one round trip.
   *
   * The server announces every save, and a sheet being typed into saves about
   * once a second — so without this, every other browser in the space would
   * reload the list once a second for the length of someone else's sentence.
   */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshListSoon = useCallback(() => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      void refreshSheets().catch(() => undefined);
      void refreshFolders();
    }, LIVE_SETTLE_MS);
  }, [refreshSheets, refreshFolders]);

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  /**
   * What each announcement from the server means for what is on screen.
   *
   * Rebuilt every render, which is why `useLive` reads it through a ref: it has
   * to close over the sheet that is open and whether this browser holds its
   * lock, and neither is worth reopening the stream over.
   */
  onLive.current = (event: LiveEvent) => {
    switch (event.type) {
      case 'hello':
        /*
         * A stream that has just connected may be one that reconnected, and a
         * reconnect cannot know what it missed — the server keeps no log to
         * replay. So everything visible is re-read rather than any attempt made
         * to work out the size of the gap.
         */
        refreshListSoon();
        void api
          .settings()
          .then(setSettings)
          .catch(() => undefined);
        void refreshRates();
        if (activeId) {
          void api
            .getSheet(activeId)
            .then((sheet) => applyHolder(sheet.id, sheet.lock ?? null))
            .catch(() => undefined);
        }
        break;

      case 'list':
        if (event.owner === space) refreshListSoon();
        break;

      case 'sheet': {
        if (event.id !== activeId) break;
        // Holding the lock means this is our own save coming back, or an edit
        // that got past the lock — and the version check on the next save is
        // what covers the second case, with the conflict panel behind it.
        if (lock.granted) break;
        // Reading along as someone else writes. Never over unsaved text: a tab
        // that lost the lock mid-sentence still has that sentence in the box,
        // and it has nowhere else to be.
        if (content !== savedContent.current) break;
        void openSheet(event.id).catch(() => undefined);
        break;
      }

      case 'lock':
        applyHolder(event.sheetId, event.holder);
        break;

      case 'rates':
        void refreshRates();
        break;

      case 'settings':
        // A change to the instance-wide tier arrives with a null owner and
        // resolves into this space's effective values, so both are worth
        // re-reading here.
        if (event.owner === null || event.owner === space) {
          void api
            .settings()
            .then(setSettings)
            .catch(() => undefined);
        }
        break;
    }
  };

  /*
   * The fallback the stream is allowed to fail into.
   *
   * A proxy that buffers responses accepts the connection and then holds every
   * event until it ends, which for this stream is never — so `live` is false
   * whenever nothing has arrived recently, whatever the socket thinks. Asking
   * on a timer is slower than being told and still much better than the app's
   * previous answer, which was to find out when you happened to act.
   */
  useEffect(() => {
    if (live) return;
    const timer = setInterval(refreshListSoon, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [live, refreshListSoon]);

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
       * Text size. The View menu was printing these two against Bigger and
       * Smaller text while nothing listened for them — a menu claiming a key
       * that does nothing is the same fault #78 was about, one level up.
       *
       * `+` arrives as `=` on an unshifted US layout and as `+` with shift, so
       * both spell the same command; `_` is the shifted `-` for the same
       * reason. Taking the event stops the browser zooming the whole page,
       * which is emphatically not what was asked for.
       */
      if (mod && ['+', '=', '-', '_'].includes(event.key)) {
        event.preventDefault();
        const bigger = event.key === '+' || event.key === '=';
        void persistSettings({
          sheetFontSize: clampFontSize(fontSize + (bigger ? FONT_STEP : -FONT_STEP)),
        });
      }

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
          closeOverlay();
          editorRef.current?.openSearch();
        }
      }
      if (
        mod &&
        (event.key.toLowerCase() === 'k' ||
          (event.shiftKey && event.key.toLowerCase() === 'f'))
      ) {
        event.preventDefault();
        setOverlay('palette');
      }

      if (event.key === 'Escape') {
        closeOverlay();
      }
      // `?` opens the reference, but not while a field or the sheet has focus.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.closest('input, textarea, .cm-editor, [contenteditable]') !== null;
      if (event.key === '?' && !typing) {
        event.preventDefault();
        toggleOverlay('reference');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `fontSize` is read when the key is pressed, so the listener has to be
    // rebound as it changes or every press would step from the size the sheet
    // was opened at.
  }, [createSheet, fontSize, persistSettings]);

  const takeOver = async () => {
    if (!activeId) return;
    try {
      // The sheet is re-read between the server granting the lock and this
      // browser being told it may edit, so the box is never editable while it
      // still shows what the previous holder was working on.
      await claimLock(activeId, { force: true, after: () => openSheet(activeId) });
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const addSpace = async () => {
    const name = await ask.name({
      title: 'Name for the new space',
      value: '',
      confirm: 'Add space',
    });
    if (name === null) return;
    await addSpaceNamed(name);
  };

  /** The switcher's rename, which has to ask for the name first. */
  const renameSpace = async (user: User) => {
    const next = await ask.name({
      title: 'Rename space',
      value: user.name,
      confirm: 'Rename',
    });
    if (next === null) return;
    await applySpaceName(user, next);
  };

  /**
   * Asks before removing a space, in the words the answer deserves.
   *
   * Its sheets are kept, not deleted, and adding the space back under the same
   * name brings them into view again — so this says that, rather than the
   * usual "cannot be undone", which would be untrue and would make the choice
   * feel more dangerous than it is.
   */
  const removeSpace = async (user: User) => {
    const agreed = await ask.confirm({
      title: `Remove the space “${user.name}”?`,
      body:
        'Any sheets in it are kept, but stay hidden until a space is added ' +
        'back under the same name.',
      confirm: 'Remove space',
    });
    if (agreed) await removeSpaceConfirmed(user);
  };

  const renameSheet = async (sheet: SheetSummary) => {
    const next = await ask.name({
      title: 'Rename sheet',
      value: sheet.title,
      confirm: 'Rename',
    });
    if (next === null || next === sheet.title) return;
    try {
      await api.saveSheet(sheet.id, { title: next }, sheet.version);
      if (sheet.id === activeId) await openSheet(sheet.id);
      await refreshSheets();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const deleteSheet = async (sheet: SheetSummary) => {
    const permanent = viewingTrash;
    if (permanent) {
      const agreed = await ask.confirm({
        title: `Permanently delete “${sheet.title}”?`,
        body: 'This one cannot be undone — the sheet does not go to the trash first.',
        confirm: 'Delete permanently',
      });
      if (!agreed) return;
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
  const shareSheet = async (): Promise<{ url: string; copied: boolean } | null> => {
    if (!activeId) return null;
    try {
      const trimmed = title.trim();
      if (trimmed && trimmed !== sheets.find((s) => s.id === activeId)?.title) {
        await save({ title: trimmed });
      }
      const { slug } = await api.shareSheet(activeId);
      const url = `${window.location.origin}/s/${slug}`;
      return { url, copied: await copyToClipboard(url) };
    } catch (cause) {
      setError(describe(cause));
      return null;
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
    // The size is set here rather than in the stylesheet so the line height,
    // the answer column and the gutter — all of which derive from it — scale
    // together instead of drifting apart at the edges of the range.
    <div
      className="app"
      style={{ '--sheet-font-size': `${fontSize}px` } as CSSProperties}
    >
      <TopBar
        title={title}
        status={status}
        lock={lock}
        activeId={activeId}
        sheetOwner={sheetOwner}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        theme={theme}
        setTitle={setTitle}
        save={save}
        statusLabel={statusLabel}
        statistic={statistic}
        siNotation={siNotation}
        showLineNumbers={showLineNumbers}
        countVariables={countVariables}
        countReferenced={countReferenced}
        showTotal={showTotal}
        fontSize={fontSize}
        precision={precision}
        thousandsSeparators={thousandsSeparators}
        currencyRounding={currencyRounding}
        persistSettings={persistSettings}
        session={session}
        users={users}
        space={space}
        currentUserName={currentUserName}
        sheets={sheets}
        addSpace={addSpace}
        renameSpace={renameSpace}
        removeSpace={removeSpace}
        onOpenSpaceSettings={() => setOverlay('space-settings')}
        onOpenGlobalSettings={() => setOverlay('global-settings')}
        onOpenReference={() => toggleOverlay('reference')}
        shareSheet={shareSheet}
        exportAs={exportAs}
      />

      <Banners
        error={error}
        notice={notice}
        lock={lock}
        activeId={activeId}
        viewingTrash={viewingTrash}
        onDismissError={() => setError(null)}
        onDismissNotice={() => setNotice(null)}
        onTakeOver={() => void takeOver()}
      />

      {/* Whatever is being asked, if anything. One place, near the root, so a
          question sits over the app rather than inside whichever panel raised
          it. */}
      {ask.dialog}

      {conflict && (
        <Conflict
          mine={content}
          theirs={conflict.content}
          onKeepMine={() => void save({ content }, conflict.version)}
          onTakeTheirs={takeTheirs}
          onKeepBoth={() => void keepBoth()}
        />
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
          onRestore={restoreSheet}
          onMove={moveSheet}
          onQuery={setQuery}
          onCreateFolder={() => {
            void ask
              .name({
                title: 'Name for the new folder',
                value: '',
                confirm: 'Create folder',
              })
              .then((name) => {
                if (name !== null) createFolder(name);
              });
          }}
          onRenameFolder={(folder) => {
            void ask
              .name({ title: 'Rename folder', value: folder.name, confirm: 'Rename' })
              .then((name) => {
                if (name !== null) renameFolder(folder, name);
              });
          }}
          onDeleteFolder={(folder) => {
            void ask
              .confirm({
                title: `Delete the folder “${folder.name}”?`,
                body: 'The sheets in it are kept, and return to the top level.',
                confirm: 'Delete folder',
              })
              .then((agreed) => {
                if (agreed) deleteFolder(folder);
              });
          }}
          onColorSheet={colorSheet}
          onColorFolder={colorFolder}
          manualOrder={settings.sheetOrder === 'manual'}
          onReorder={reorderSheets}
          onSortByRecent={() => {
            // The positions are left alone, so flipping to recent to find
            // something and back again does not cost the arrangement.
            void persistSettings({ sheetOrder: 'recent' }).then(() => refreshSheets());
          }}
          onToggleTrash={() => setViewingTrash((viewing) => !viewing)}
          onEmptyTrash={() => {
            void ask
              .confirm({
                title: 'Empty the trash?',
                body: 'Everything in it is deleted for good. This cannot be undone.',
                confirm: 'Empty trash',
              })
              .then((agreed) => {
                if (agreed) void api.emptyTrash().then(() => refreshSheets());
              });
          }}
        />
        <div className="sheet-pane">
          <div className="sheet-scroll">
            <Editor
              ref={editorRef}
              sheetId={activeId}
              value={content}
              results={results}
              readOnly={!lock.granted}
              reveal={reveal}
              showLineNumbers={showLineNumbers}
              summarise={summariseLines}
              tokenize={tokenizeSheet}
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
          open={overlay === 'space-settings'}
          space={{ id: space, name: currentUserName || space }}
          globals={settings.globals ?? NO_GLOBALS}
          sharedGlobals={settings.sharedGlobals ?? NO_GLOBALS}
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
            closeOverlay();
            void removeSpace(current);
          }}
          onClose={closeOverlay}
        />
      )}

      <GlobalSettings
        open={overlay === 'global-settings'}
        computed={settings.shared ?? {}}
        globals={settings.sharedGlobals ?? NO_GLOBALS}
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
        onClose={closeOverlay}
      />

      <Palette
        open={overlay === 'palette'}
        recent={sheets}
        onClose={closeOverlay}
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
        open={overlay === 'reference'}
        currencies={engine.currencies}
        rateDate={engine.rateDate}
        // Carried across with the date, or moving it off the bar would drop
        // the warning rather than relocate it.
        ratesStale={rates?.stale === true}
        holidayCount={holidays?.dates.length ?? 0}
        onClose={closeOverlay}
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

const lastSheetKey = (space: string) => `sumline.lastSheet.${space}`;

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

/**
 * Keeps a stored size inside what the sheet can actually be read at.
 *
 * The settings store is free-form, so a hand-edited or stale value arrives
 * unchecked — and a sheet set to 2px is one nobody can find the menu to fix.
 */
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
