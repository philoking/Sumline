import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type Folder, type SheetSummary } from './api';

/**
 * The list with `ids` rearranged, and everything else left alone.
 *
 * A drag sends the ids of the group it happened in, which for a sheet inside a
 * folder is that folder's sheets and nothing more. This used to return exactly
 * the sheets it was given, so reordering two rows inside a folder emptied the
 * sidebar of every sheet outside it until the server answered and the refresh
 * put them back. Visible as everything else blinking out mid-drag, for the
 * length of a round trip, and longest exactly when the network is worst.
 *
 * The slots the moving sheets already occupy are the slots they get back, in
 * their new order. That is the same rule the server applies: "only the
 * positions those sheets already hold get reassigned, so reordering inside a
 * folder or a search leaves everything off screen where it was". The optimistic
 * paint and the answer that replaces it now agree, which is the point of an
 * optimistic paint.
 *
 * Exported for its own sake: it is the whole of the bug, it is a pure list
 * transformation, and testing it needs none of the React harness the hooks
 * around it are still waiting on.
 */
export function reordered(current: SheetSummary[], ids: string[]): SheetSummary[] {
  const moving = new Set(ids);
  const byId = new Map(current.map((sheet) => [sheet.id, sheet]));
  const order = ids.map((id) => byId.get(id)).filter((sheet) => sheet !== undefined);
  let next = 0;
  return current.map((sheet) =>
    moving.has(sheet.id) ? (order[next++] ?? sheet) : sheet,
  );
}

export interface SheetList {
  sheets: SheetSummary[];
  folders: Folder[];
  /** Re-reads the list under the filters in force. */
  refresh: () => Promise<SheetSummary[]>;
  /** Re-reads the folders, which no filter applies to. */
  refreshFolders: () => Promise<void>;
  setSheets: Dispatch<SetStateAction<SheetSummary[]>>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  restore(sheet: SheetSummary): void;
  move(sheet: SheetSummary, folderId: string | null): void;
  createFolder(name: string): void;
  renameFolder(folder: Folder, name: string): void;
  deleteFolder(folder: Folder): void;
  colorSheet(sheet: SheetSummary, color: string | null): void;
  colorFolder(folder: Folder, color: string | null): void;
  reorder(ids: string[]): void;
}

/**
 * The sidebar's contents, and every change that can be made to them.
 *
 * These were a dozen callbacks written inline in the JSX, each opening a
 * request, painting an optimistic result, re-reading afterwards and reporting
 * its own failure — the same four steps a dozen times, a hundred lines deep
 * into a render method.
 *
 * Naming them does two things. The rules they share stop being a coincidence:
 * a change made by eye is painted first and reconciled after, and a failure
 * both reports itself and re-reads, because a sidebar left showing an
 * optimistic result that did not happen is worse than one that flickers.
 * And what is left in the JSX is the sidebar's *behaviour* — which prompt to
 * ask, which panel to close — rather than the wiring underneath it.
 *
 * Asking is deliberately not in here. `createFolder` takes a name rather than
 * fetching one, so the question stays where the interface is and can become a
 * proper dialog (#99) without this file knowing.
 */
export function useSheetList(options: {
  /** The sidebar's search box, which filters what `refresh` returns. */
  query: string;
  viewingTrash: boolean;
  onError: (cause: unknown) => void;
  /** Told when a drag has just made the order manual. */
  onManualOrder: () => void;
}): SheetList {
  const { query, viewingTrash, onError, onManualOrder } = options;

  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);

  const refresh = useCallback(async () => {
    const list = await api.listSheets({
      ...(query && { query }),
      ...(viewingTrash && { trashed: true }),
    });
    setSheets(list);
    return list;
  }, [query, viewingTrash]);

  const refreshFolders = useCallback(async () => {
    await api
      .listFolders()
      .then(setFolders)
      .catch(() => undefined);
  }, []);

  /**
   * The shape every mutation below shares.
   *
   * `paint` is the optimistic half, applied at once because these are changes
   * made by eye — waiting a round trip to see a colour land makes picking
   * through the palette feel broken. `settle` re-reads whatever the answer
   * was, and a failure does both: says so, and re-reads anyway, because the
   * paint has to be undone by the truth rather than left standing.
   */
  const mutate = useCallback(
    (act: () => Promise<unknown>, settle: () => Promise<unknown>) => {
      void act()
        .then(() => settle())
        .catch((cause: unknown) => {
          onError(cause);
          void settle();
        });
    },
    [onError],
  );

  const restore = useCallback(
    (sheet: SheetSummary) => mutate(() => api.restoreSheet(sheet.id), refresh),
    [mutate, refresh],
  );

  const move = useCallback(
    (sheet: SheetSummary, folderId: string | null) =>
      mutate(() => api.saveSheet(sheet.id, { folderId }, sheet.version), refresh),
    [mutate, refresh],
  );

  const createFolder = useCallback(
    (name: string) => mutate(() => api.createFolder(name), refreshFolders),
    [mutate, refreshFolders],
  );

  const renameFolder = useCallback(
    (folder: Folder, name: string) =>
      mutate(() => api.renameFolder(folder.id, name), refreshFolders),
    [mutate, refreshFolders],
  );

  const deleteFolder = useCallback(
    (folder: Folder) => mutate(() => api.deleteFolder(folder.id), refreshFolders),
    [mutate, refreshFolders],
  );

  const colorSheet = useCallback(
    (sheet: SheetSummary, color: string | null) => {
      setSheets((current) =>
        current.map((entry) => (entry.id === sheet.id ? { ...entry, color } : entry)),
      );
      mutate(() => api.setSheetColor(sheet.id, color), refresh);
    },
    [mutate, refresh],
  );

  const colorFolder = useCallback(
    (folder: Folder, color: string | null) => {
      setFolders((current) =>
        current.map((entry) => (entry.id === folder.id ? { ...entry, color } : entry)),
      );
      mutate(() => api.setFolderColor(folder.id, color), refreshFolders);
    },
    [mutate, refreshFolders],
  );

  const reorder = useCallback(
    (ids: string[]) => {
      // Painted first so the row lands where it was dropped rather than
      // springing back for the length of a round trip.
      setSheets((current) => reordered(current, ids));
      // The server changes the setting as part of the reorder; this keeps the
      // local copy from lagging a render behind it.
      onManualOrder();
      mutate(() => api.reorderSheets(ids), refresh);
    },
    [mutate, refresh, onManualOrder],
  );

  return {
    sheets,
    folders,
    refresh,
    refreshFolders,
    setSheets,
    setFolders,
    restore,
    move,
    createFolder,
    renameFolder,
    deleteFolder,
    colorSheet,
    colorFolder,
    reorder,
  };
}
