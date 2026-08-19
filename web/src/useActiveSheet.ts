import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { api, ConflictError, type Sheet } from './api';

/** What the bar above the sheet is currently saying about it. */
export type Status = 'idle' | 'unsaved' | 'saving' | 'saved' | 'readonly' | 'error';

/**
 * How long after the last keystroke a sheet saves itself.
 *
 * Long enough that a sentence is one save rather than thirty, short enough
 * that nobody is watching the word "unsaved" while they think.
 */
const AUTOSAVE_DELAY_MS = 800;

export interface ActiveSheet {
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  content: string;
  setContent: Dispatch<SetStateAction<string>>;
  version: number;
  /** Whose sheet it is, which is not always the space you are in. */
  sheetOwner: string | null;
  /** The server's copy, when a save was refused because it had moved on. */
  conflict: Sheet | null;
  /**
   * The text as the server last confirmed it.
   *
   * A ref rather than state because nothing renders differently for it: it is
   * the comparison that decides whether there is anything to save, and reading
   * along as somebody else types must never overwrite unsaved text.
   */
  savedContent: RefObject<string>;
  open(id: string): Promise<Sheet>;
  save(
    changes: { title?: string; content?: string; folderId?: string | null },
    useVersion?: number,
  ): Promise<void>;
  /** Resolves a conflict by keeping the server's copy as a sheet of its own. */
  keepBoth(): Promise<void>;
  /** Resolves it the other way: theirs wins, and this browser catches up. */
  takeTheirs(): void;
}

/**
 * The open sheet: its text, its version, saving it, and the two ways a save
 * can be refused.
 *
 * These belong together and were spread through `App.tsx` among everything
 * else it holds. Autosave depends on what the server last confirmed, which
 * depends on what the last save returned, which is also what decides whether a
 * conflict is showing — and a reader following any one of those had to hold
 * all thirty of the component's states to do it.
 *
 * The lock is not here. Whether this browser *may* write is `useSheetLock`'s
 * question, and it arrives as `canEdit`; what happens when it writes is this
 * one's.
 */
export function useActiveSheet(options: {
  activeId: string | null;
  /** Whether this browser holds the editing lock. */
  canEdit: boolean;
  /** Refreshes the sidebar, so a renamed sheet shows its new name. */
  refreshSheets: () => Promise<unknown>;
  /** Which folder a sheet is in, so a conflicted copy lands beside it. */
  folderOf: (id: string) => string | null;
  onStatus: (status: Status) => void;
  onError: (cause: unknown) => void;
  onNotice: (message: string) => void;
}): ActiveSheet {
  const { activeId, canEdit, refreshSheets, folderOf, onStatus, onError, onNotice } =
    options;

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [version, setVersion] = useState(0);
  const [sheetOwner, setSheetOwner] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Sheet | null>(null);
  const savedContent = useRef('');

  /** The latest callbacks, so the effects below do not restart every render. */
  const report = useRef({ onStatus, onError, onNotice });
  report.current = { onStatus, onError, onNotice };

  const open = useCallback(async (id: string) => {
    const sheet = await api.getSheet(id);
    setTitle(sheet.title);
    setContent(sheet.content);
    setVersion(sheet.version);
    setSheetOwner(sheet.owner);
    savedContent.current = sheet.content;
    setConflict(null);
    report.current.onStatus('idle');
    return sheet;
  }, []);

  const save = useCallback(
    async (
      changes: { title?: string; content?: string; folderId?: string | null },
      useVersion = version,
    ) => {
      if (!activeId) return;
      report.current.onStatus('saving');
      try {
        const sheet = await api.saveSheet(activeId, changes, useVersion);
        setVersion(sheet.version);
        savedContent.current = sheet.content;
        setTitle(sheet.title);
        report.current.onStatus('saved');
        setConflict(null);
        void refreshSheets();
      } catch (cause) {
        if (cause instanceof ConflictError) {
          // Hand back the server's copy rather than just failing, so the panel
          // can show what this save would have overwritten.
          setConflict(cause.current);
          report.current.onStatus('error');
          return;
        }
        report.current.onError(cause);
        report.current.onStatus('error');
      }
    },
    [activeId, version, refreshSheets],
  );

  /**
   * The current `save`, reachable from the autosave timer below.
   *
   * `save` is remade whenever the version changes and whenever the sidebar's
   * query does, since it refreshes the list. An effect that listed it among
   * its dependencies would therefore tear down its timer and start it again on
   * every keystroke in the search box — pushing an unsaved sheet's save out by
   * however long somebody spent typing somewhere else entirely.
   */
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!activeId || !canEdit || conflict) return;
    if (content === savedContent.current) return;
    report.current.onStatus('unsaved');
    // Deliberately not depending on `save`: the debounce belongs to the thing
    // being debounced, which is the content and the guards around saving it.
    const handle = setTimeout(() => void saveRef.current({ content }), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [content, activeId, canEdit, conflict]);

  /**
   * Resolves a conflict by keeping the server's copy as a sheet of its own.
   *
   * The copy is made *before* ours overwrites it, so a failure to create it
   * leaves the server's version where it is rather than destroying it on the
   * way to preserving it. It goes in the same folder, since that is where
   * someone will look for it.
   */
  const keepBoth = useCallback(async () => {
    if (!conflict || !activeId) return;
    try {
      const copy = await api.createSheet(
        `${title || 'Untitled'} (conflicted copy)`,
        conflict.content,
        folderOf(activeId),
      );
      await save({ content }, conflict.version);
      await refreshSheets();
      report.current.onNotice(
        `The server’s version is kept as “${copy.title}”. Nothing was lost.`,
      );
    } catch (cause) {
      report.current.onError(cause);
    }
  }, [conflict, activeId, title, content, save, refreshSheets, folderOf]);

  const takeTheirs = useCallback(() => {
    if (!conflict) return;
    setContent(conflict.content);
    setVersion(conflict.version);
    // Moved together, and this line is why they are together: the text and the
    // mark of what the server has are the same fact, and a save decides what
    // to send by comparing them.
    savedContent.current = conflict.content;
    setConflict(null);
    report.current.onStatus('idle');
  }, [conflict]);

  return {
    title,
    setTitle,
    content,
    setContent,
    version,
    sheetOwner,
    conflict,
    savedContent,
    open,
    save,
    keepBoth,
    takeTheirs,
  };
}
