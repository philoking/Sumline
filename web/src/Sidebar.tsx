import { useState, type CSSProperties, type MouseEvent } from 'react';
import type { Folder, SheetSummary } from './api';
import { SHEET_COLORS, colorClass, colorLabel } from './colors';

/**
 * Roughly how tall the tallest flyout is: rename, move up, move down, two
 * swatch rows and the clear button.
 *
 * An over-estimate on purpose. Guessing high only flips a menu upwards a
 * little sooner than it had to; guessing low leaves one clipped at the bottom
 * of the window, which is the failure worth avoiding.
 */
const FLYOUT_HEIGHT = 200;

/**
 * Places the flyout against the button that opened it.
 *
 * Fixed rather than absolute, and so positioned by hand, because the sheet
 * list scrolls: an absolutely positioned menu inside it is clipped at the
 * container's edge, which for the last sheet in a long list means a palette
 * that is half there. Opening upwards when there is no room below is what
 * makes the folder rows at the very bottom of the sidebar usable.
 */
function flyoutStyle(anchor: DOMRect): CSSProperties {
  const openUpwards = anchor.bottom + FLYOUT_HEIGHT > window.innerHeight;
  return {
    right: Math.max(8, window.innerWidth - anchor.right),
    ...(openUpwards
      ? { bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4 }),
  };
}

/**
 * The palette shown under the ✎ on a sheet or a folder.
 *
 * Both rows get the same control, so colour coding a folder and colour coding
 * a sheet are the same gesture rather than two things to learn.
 */
function ColorPalette({
  current,
  onPick,
}: {
  current: string | null;
  onPick(color: string | null): void;
}) {
  return (
    <div className="palette" role="group" aria-label="Colour">
      <div className="swatches">
        {SHEET_COLORS.map((color) => (
          <button
            key={color.id}
            type="button"
            className={`swatch tint-${color.id}${current === color.id ? ' picked' : ''}`}
            title={color.label}
            aria-label={color.label}
            aria-pressed={current === color.id}
            onClick={() => onPick(color.id)}
          />
        ))}
      </div>
      <button
        type="button"
        className="palette-clear"
        disabled={current === null}
        onClick={() => onPick(null)}
      >
        {current === null ? 'No colour' : `Clear ${colorLabel(current).toLowerCase()}`}
      </button>
    </div>
  );
}

export interface SidebarProps {
  sheets: SheetSummary[];
  folders: Folder[];
  activeId: string | null;
  /** undefined = all sheets, null = top level, string = that folder. */
  activeFolder: string | null | undefined;
  query: string;
  viewingTrash: boolean;
  open: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  onRename(sheet: SheetSummary): void;
  onDelete(sheet: SheetSummary): void;
  onRestore(sheet: SheetSummary): void;
  onMove(sheet: SheetSummary, folderId: string | null): void;
  onQuery(value: string): void;
  onSelectFolder(folderId: string | null | undefined): void;
  onCreateFolder(): void;
  onRenameFolder(folder: Folder): void;
  onDeleteFolder(folder: Folder): void;
  onColorSheet(sheet: SheetSummary, color: string | null): void;
  onColorFolder(folder: Folder, color: string | null): void;
  /** The sheets as they should now read, top to bottom. */
  onReorder(ids: string[]): void;
  /** True when this space arranges its list by hand. */
  manualOrder: boolean;
  onSortByRecent(): void;
  onToggleTrash(): void;
  onEmptyTrash(): void;
}

/** Moves one entry of a list to another index, returning a new list. */
function movedTo<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

export function Sidebar(props: SidebarProps) {
  const {
    sheets, folders, activeId, activeFolder, query, viewingTrash, open,
    onSelect, onCreate, onRename, onDelete, onRestore, onMove, onQuery,
    onSelectFolder, onCreateFolder, onRenameFolder, onDeleteFolder,
    onColorSheet, onColorFolder, onReorder, manualOrder, onSortByRecent,
    onToggleTrash, onEmptyTrash,
  } = props;

  /**
   * The row being dragged and the gap it would drop into.
   *
   * Held here rather than reordering `sheets` as the pointer moves, so the
   * list only changes once — on drop — and a drag abandoned outside the
   * sidebar leaves nothing to undo.
   */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  /** Reordering the trash is meaningless, and search results are not a list
      you own the order of — both would write positions for a view that isn't
      the arrangement. */
  const reorderable = !viewingTrash && query === '' && sheets.length > 1;

  const finishDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  const dropDragged = (target: number) => {
    const from = sheets.findIndex((sheet) => sheet.id === dragging);
    finishDrag();
    if (from === -1) return;
    // A drop below its own row means the gap after it, which is where it
    // already is once the row itself is taken out of the list.
    const to = target > from ? target - 1 : target;
    if (to === from) return;
    onReorder(movedTo(sheets, from, to).map((sheet) => sheet.id));
  };

  /** Nudges a sheet one place, for a keyboard or a phone. */
  const nudge = (sheet: SheetSummary, by: -1 | 1) => {
    const from = sheets.findIndex((entry) => entry.id === sheet.id);
    const to = from + by;
    if (from === -1 || to < 0 || to >= sheets.length) return;
    onReorder(movedTo(sheets, from, to).map((entry) => entry.id));
  };

  /**
   * Which row has its edit flyout open, and where to put it.
   *
   * Keyed by kind as well as id so a folder and a sheet that happened to share
   * an id could not open each other's menu.
   */
  const [editing, setEditing] = useState<{
    kind: 'sheet' | 'folder';
    id: string;
    anchor: DOMRect;
  } | null>(null);

  const isEditing = (kind: 'sheet' | 'folder', id: string) =>
    editing?.kind === kind && editing.id === id;
  const closeEditor = () => setEditing(null);

  const toggleEditor = (
    kind: 'sheet' | 'folder',
    id: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const anchor = event.currentTarget.getBoundingClientRect();
    setEditing((current) =>
      current?.kind === kind && current.id === id ? null : { kind, id, anchor },
    );
  };

  return (
    <aside className={`sidebar${open ? '' : ' sidebar-collapsed'}`}>
      <button type="button" className="new-sheet" onClick={onCreate}>
        <span className="plus">+</span>
        New Sheet
      </button>

      <div className="sidebar-search">
        <input
          type="search"
          value={query}
          placeholder="Search sheets"
          onChange={(event) => onQuery(event.target.value)}
          aria-label="Search sheets"
        />
      </div>

      {manualOrder && !viewingTrash && (
        <div className="order-note">
          <span>Custom order</span>
          <button type="button" onClick={onSortByRecent} title="Sort by most recent">
            Sort by recent
          </button>
        </div>
      )}

      <ul className="sheet-list" onDragLeave={() => setDropAt(null)}>
        {sheets.map((sheet, index) => (
          <li
            key={sheet.id}
            className={[
              sheet.id === activeId ? 'active' : '',
              dragging === sheet.id ? 'dragging' : '',
              dropAt === index ? 'drop-before' : '',
              dropAt === index + 1 && index === sheets.length - 1 ? 'drop-after' : '',
            ]
              .filter(Boolean)
              .join(' ') + colorClass(sheet.color)}
            draggable={reorderable}
            onDragStart={(event) => {
              setDragging(sheet.id);
              event.dataTransfer.effectAllowed = 'move';
              // Firefox ignores a drag that carries no data at all.
              event.dataTransfer.setData('text/plain', sheet.id);
            }}
            onDragEnd={finishDrag}
            onDragOver={(event) => {
              if (!dragging || !reorderable) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              // Past the midpoint means the gap below this row, which is what
              // makes dropping onto the lower half of the last row land at the
              // very bottom rather than second to last.
              const box = event.currentTarget.getBoundingClientRect();
              const below = event.clientY > box.top + box.height / 2;
              setDropAt(index + (below ? 1 : 0));
            }}
            onDrop={(event) => {
              event.preventDefault();
              dropDragged(dropAt ?? index);
            }}
          >
            <button
              type="button"
              className="sheet-link"
              onClick={() => onSelect(sheet.id)}
            >
              <span className="sheet-name">{sheet.title}</span>
              <span className="sheet-meta">
                <span>{formatTime(sheet.updatedAt)}</span>
                <span>{sheet.lines === 1 ? '1 line' : `${sheet.lines} lines`}</span>
              </span>
            </button>
            <span className="sheet-actions">
              {viewingTrash ? (
                <button
                  type="button"
                  className="ghost"
                  title="Restore"
                  onClick={() => onRestore(sheet)}
                >
                  ↩
                </button>
              ) : (
                <>
                  {folders.length > 0 && (
                    <select
                      className="move-select"
                      title="Move to folder"
                      value={sheet.folderId ?? ''}
                      onChange={(event) =>
                        onMove(sheet, event.target.value || null)
                      }
                    >
                      <option value="">No folder</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    title="Rename or colour"
                    aria-haspopup="menu"
                    aria-expanded={isEditing('sheet', sheet.id)}
                    onClick={(event) => toggleEditor('sheet', sheet.id, event)}
                  >
                    ✎
                  </button>
                </>
              )}
              <button
                type="button"
                className="ghost"
                title={viewingTrash ? 'Delete permanently' : 'Move to trash'}
                onClick={() => onDelete(sheet)}
              >
                ×
              </button>
            </span>

            {editing?.kind === 'sheet' && editing.id === sheet.id && (
              <>
                <div className="menu-backdrop" onClick={closeEditor} />
                <div className="edit-flyout" role="menu" style={flyoutStyle(editing.anchor)}>
                  <button
                    type="button"
                    role="menuitem"
                    className="flyout-item"
                    onClick={() => {
                      closeEditor();
                      onRename(sheet);
                    }}
                  >
                    Rename…
                  </button>
                  {/* The same reorder a drag performs, reachable from a
                      keyboard and workable on a phone, where the sidebar is
                      an overlay and dragging fights the scroll. */}
                  {reorderable && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="flyout-item"
                        disabled={index === 0}
                        onClick={() => {
                          closeEditor();
                          nudge(sheet, -1);
                        }}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="flyout-item"
                        disabled={index === sheets.length - 1}
                        onClick={() => {
                          closeEditor();
                          nudge(sheet, 1);
                        }}
                      >
                        Move down
                      </button>
                    </>
                  )}
                  <ColorPalette
                    current={sheet.color}
                    onPick={(color) => {
                      closeEditor();
                      onColorSheet(sheet, color);
                    }}
                  />
                </div>
              </>
            )}
          </li>
        ))}
        {sheets.length === 0 && (
          <li className="empty">
            {query ? 'Nothing matches' : viewingTrash ? 'Trash is empty' : 'No sheets yet'}
          </li>
        )}
      </ul>

      <div className="sidebar-foot">
        <button
          type="button"
          className={`folder-link${activeFolder === undefined && !viewingTrash ? ' active' : ''}`}
          onClick={() => onSelectFolder(undefined)}
        >
          <span className="folder-icon">▤</span> All sheets
        </button>

        {folders.map((folder) => (
          <div key={folder.id} className={`folder-row${colorClass(folder.color)}`}>
            <button
              type="button"
              className={`folder-link${activeFolder === folder.id ? ' active' : ''}`}
              onClick={() => onSelectFolder(folder.id)}
            >
              <span className="folder-icon">🗀</span> {folder.name}
            </button>
            <span className="folder-actions">
              <button
                type="button"
                className="ghost"
                title="Rename or colour folder"
                aria-haspopup="menu"
                aria-expanded={isEditing('folder', folder.id)}
                onClick={(event) => toggleEditor('folder', folder.id, event)}
              >
                ✎
              </button>
              <button
                type="button"
                className="ghost"
                title="Delete folder (its sheets are kept)"
                onClick={() => onDeleteFolder(folder)}
              >
                ×
              </button>
            </span>

            {editing?.kind === 'folder' && editing.id === folder.id && (
              <>
                <div className="menu-backdrop" onClick={closeEditor} />
                <div className="edit-flyout" role="menu" style={flyoutStyle(editing.anchor)}>
                  <button
                    type="button"
                    role="menuitem"
                    className="flyout-item"
                    onClick={() => {
                      closeEditor();
                      onRenameFolder(folder);
                    }}
                  >
                    Rename…
                  </button>
                  <ColorPalette
                    current={folder.color}
                    onPick={(color) => {
                      closeEditor();
                      onColorFolder(folder, color);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        ))}

        <button type="button" className="folder-link" onClick={onCreateFolder}>
          <span className="folder-icon">+</span> New folder
        </button>

        <div className="folder-row">
          <button
            type="button"
            className={`folder-link${viewingTrash ? ' active' : ''}`}
            onClick={onToggleTrash}
          >
            <span className="folder-icon">🗑</span> Trash
          </button>
          {viewingTrash && sheets.length > 0 && (
            <span className="folder-actions">
              <button
                type="button"
                className="ghost"
                title="Empty trash"
                onClick={onEmptyTrash}
              >
                Empty
              </button>
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Time of day for sheets touched today, a date for anything older. */
function formatTime(iso: string): string {
  const when = new Date(iso);
  const today = new Date();
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();

  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
