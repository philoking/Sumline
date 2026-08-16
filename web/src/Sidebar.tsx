import type { Folder, SheetSummary } from './api';

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
  onToggleTrash(): void;
  onEmptyTrash(): void;
}

export function Sidebar(props: SidebarProps) {
  const {
    sheets, folders, activeId, activeFolder, query, viewingTrash, open,
    onSelect, onCreate, onRename, onDelete, onRestore, onMove, onQuery,
    onSelectFolder, onCreateFolder, onRenameFolder, onDeleteFolder,
    onToggleTrash, onEmptyTrash,
  } = props;

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
          <li key={sheet.id} className={sheet.id === activeId ? 'active' : ''}>
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
                    title="Rename"
                    onClick={() => onRename(sheet)}
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
          <div key={folder.id} className="folder-row">
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
                title="Rename folder"
                onClick={() => onRenameFolder(folder)}
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
