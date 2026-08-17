import { useState, type CSSProperties, type MouseEvent } from 'react';
import type { Folder, SheetSummary } from './api';
import { SHEET_COLORS, colorClass, colorLabel } from './colors';

/** Roughly how tall a flyout is: the rename row, two swatch rows and clear. */
const FLYOUT_HEIGHT = 132;

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
  onToggleTrash(): void;
  onEmptyTrash(): void;
}

export function Sidebar(props: SidebarProps) {
  const {
    sheets, folders, activeId, activeFolder, query, viewingTrash, open,
    onSelect, onCreate, onRename, onDelete, onRestore, onMove, onQuery,
    onSelectFolder, onCreateFolder, onRenameFolder, onDeleteFolder,
    onColorSheet, onColorFolder, onToggleTrash, onEmptyTrash,
  } = props;

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

      <ul className="sheet-list">
        {sheets.map((sheet) => (
          <li
            key={sheet.id}
            className={`${sheet.id === activeId ? 'active' : ''}${colorClass(sheet.color)}`}
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
