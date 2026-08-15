import type { SheetSummary } from './api';

export interface SidebarProps {
  sheets: SheetSummary[];
  activeId: string | null;
  open: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  onRename(sheet: SheetSummary): void;
  onDelete(sheet: SheetSummary): void;
}

export function Sidebar({
  sheets,
  activeId,
  open,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SidebarProps) {
  return (
    <aside className={`sidebar${open ? '' : ' sidebar-collapsed'}`}>
      <button type="button" className="new-sheet" onClick={onCreate}>
        <span className="plus">+</span>
        New Sheet
      </button>
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
              <button
                type="button"
                className="ghost"
                title="Rename"
                onClick={() => onRename(sheet)}
              >
                ✎
              </button>
              <button
                type="button"
                className="ghost"
                title="Delete"
                onClick={() => onDelete(sheet)}
              >
                ×
              </button>
            </span>
          </li>
        ))}
        {sheets.length === 0 && <li className="empty">No sheets yet</li>}
      </ul>
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
