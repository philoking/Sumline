import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { Lock, SheetSummary, User } from './api';
import type { Settings } from './api';
import type { Status } from './useActiveSheet';
import type { Theme } from './useTheme';
import { Backdrop, useMenuKeys } from './Popover';
import { clampFontSize, ViewMenu } from './ViewMenu';
import { Mark, Wordmark } from './Wordmark';
import { formatShortcut } from './shortcuts';
import { useDialog } from './useDialog';
import { api, switchUser } from './api';

/**
 * The bar across the top, and every menu that hangs off it.
 *
 * Extracted from `App` because it was a third of that component's render and
 * because five pieces of state existed only to serve it: which of the four
 * menus is open, whether the space list is in editing mode, and the share
 * popover's link. None of that is application state — no other part of the app
 * can see it or act on it — and while it lived at the root it was recreated on
 * every keystroke in the sheet, which is the mechanism that wiped a global
 * variable as it was typed.
 *
 * What stays in `App` is the work these menus start. Sharing has to flush a
 * pending rename before it mints a link, and exporting needs the sheet's text
 * and its answers; both are handed in as functions, and this owns only whether
 * the popover is showing.
 */
export interface TopBarProps {
  title: string;
  status: Status;
  lock: { granted: boolean; holder: Lock | null };
  activeId: string | null;
  sheetOwner: string | null;
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  theme: { theme: Theme; cycle(): void; label: string; icon: string };
  setTitle: Dispatch<SetStateAction<string>>;
  save(changes: { title?: string }): Promise<void>;
  statusLabel(status: Status, lock: { granted: boolean; holder: Lock | null }): string;
  statistic: string;
  siNotation: boolean;
  showLineNumbers: boolean;
  countVariables: boolean;
  countReferenced: boolean;
  showTotal: boolean;
  fontSize: number;
  precision: number;
  thousandsSeparators: boolean;
  currencyRounding: boolean;
  persistSettings(changes: Partial<Settings>): Promise<unknown>;
  users: User[];
  space: string | null;
  currentUserName: string;
  sheets: SheetSummary[];
  addSpace(): void;
  renameSpace(user: User): void;
  removeSpace(user: User): void;
  session: { required: boolean; authenticated: boolean };
  onOpenSpaceSettings(): void;
  onOpenGlobalSettings(): void;
  onOpenReference(): void;
  /** Mints a share link, having flushed any pending rename first. */
  shareSheet(): Promise<{ url: string; copied: boolean } | null>;
  exportAs(kind: 'text' | 'markdown' | 'csv' | 'clipboard'): void;
}

export function TopBar(props: TopBarProps) {
  const {
    title,
    status,
    lock,
    activeId,
    sheetOwner,
    sidebarOpen,
    onToggleSidebar,
    theme,
    setTitle,
    save,
    statusLabel,
    users,
    space,
    currentUserName,
    sheets,
    fontSize,
    precision,
    showTotal,
    showLineNumbers,
    countVariables,
    countReferenced,
    siNotation,
    thousandsSeparators,
    currencyRounding,
    persistSettings,
    addSpace,
    renameSpace,
    removeSpace,
    session,
    onOpenSpaceSettings,
    onOpenGlobalSettings,
    onOpenReference,
    shareSheet,
    exportAs,
  } = props;

  /* Every one of these is about this bar and nothing else, which is the whole
     argument for the component existing. */
  const [exportOpen, setExportOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  /** Turns the space list into an editable one, rather than a second menu. */
  const [managingSpaces, setManagingSpaces] = useState(false);
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);

  const userMenuRef = useRef<HTMLUListElement | null>(null);
  const closeUserMenu = useCallback(() => {
    setUserMenuOpen(false);
    setManagingSpaces(false);
  }, []);
  const onUserMenuKey = useMenuKeys(userMenuRef, userMenuOpen, closeUserMenu);

  // The share popover holds the link and nothing else, so closing it has to put
  // the keyboard back on the 🔗 that opened it or there is nowhere to go.
  const shareRef = useDialog<HTMLDivElement>(share !== null, () => setShare(null));

  /*
   * Escape closes whichever of these is open.
   *
   * It used to be one branch of the root's global key handler, which could
   * reach this state while it lived there. Now that the state is here the
   * handling is too, which is the point: the bar is responsible for its own
   * menus rather than leaving a branch behind in a component that no longer
   * knows about them.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setExportOpen(false);
      setViewMenuOpen(false);
      closeUserMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeUserMenu]);

  return (
    <header className="topbar">
      {/* The mark is decorative and hidden from assistive tech — the name
          beside it says the same thing, and the document title said it
          already. What a reader needs first is the sheet's own name, which
          is why the lockup is small and the title input takes the room. */}
      <Mark />
      <Wordmark />
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
      {/* Announced rather than only shown: whether the work is saved is the
          one thing on this bar worth interrupting a reader for. */}
      <span className={`status status-${status}`} role="status">
        {statusLabel(status, lock)}
      </span>
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
            <Backdrop onClose={() => setExportOpen(false)} />
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
          onClick={() => {
            // The parent mints the link, having flushed a pending rename
            // first; what comes back is this popover's business.
            if (share) setShare(null);
            else void shareSheet().then(setShare);
          }}
          title="Copy a link to this sheet"
          aria-label="Copy a link to this sheet"
          disabled={!activeId}
        >
          🔗
        </button>
        {share && (
          <>
            <Backdrop onClose={() => setShare(null)} />
            <div
              className="answer-menu share-menu"
              role="dialog"
              aria-label="Link to this sheet"
              ref={shareRef}
              tabIndex={-1}
            >
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
        onClick={onOpenReference}
        title="What can I type? (?)"
      >
        ?
      </button>
      {/* Everything about how a sheet is shown lives behind this, rather
          than as a row of unlabelled glyphs on the bar. */}
      <div className="menu-anchor">
        <button
          type="button"
          className="ghost"
          onClick={() => setViewMenuOpen((open) => !open)}
          title="How this sheet is shown"
          aria-haspopup="menu"
          aria-expanded={viewMenuOpen}
        >
          {/* `Aa` said fonts, which is one row of this menu rather than what
              it is. An eye is the plain word for the rest of it — what is on
              screen and what is not. Not a gear, which would promise the
              settings panels; not a half-circle, which the theme button next
              door already uses. */}
          👁
        </button>
        <ViewMenu
          open={viewMenuOpen}
          fontSize={fontSize}
          sidebarOpen={sidebarOpen}
          showLineNumbers={showLineNumbers}
          showTotal={showTotal}
          countReferenced={countReferenced}
          countVariables={countVariables}
          largeNumberNotation={siNotation}
          precision={precision}
          thousandsSeparators={thousandsSeparators}
          currencyRounding={currencyRounding}
          onPrecision={(next) => void persistSettings({ precision: next })}
          onToggleSeparators={() =>
            void persistSettings({ thousandsSeparators: !thousandsSeparators })
          }
          onToggleCurrencyRounding={() =>
            void persistSettings({ currencyRounding: !currencyRounding })
          }
          onFontSize={(next) =>
            void persistSettings({ sheetFontSize: clampFontSize(next) })
          }
          onToggleSidebar={onToggleSidebar}
          onToggleLineNumbers={() =>
            void persistSettings({ showLineNumbers: !showLineNumbers })
          }
          onToggleTotal={() => void persistSettings({ showTotal: !showTotal })}
          onToggleReferenced={() =>
            void persistSettings({ countReferencedInTotal: !countReferenced })
          }
          onToggleVariables={() =>
            void persistSettings({ countVariablesInTotal: !countVariables })
          }
          onToggleNotation={() =>
            void persistSettings({ largeNumberNotation: !siNotation })
          }
          onClose={() => setViewMenuOpen(false)}
        />
      </div>
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
              <Backdrop onClose={closeUserMenu} />
              <ul
                className="answer-menu user-menu"
                role="menu"
                aria-label="Spaces"
                ref={userMenuRef}
                onKeyDown={onUserMenuKey}
              >
                {users.map((user) => (
                  <li
                    role="none"
                    key={user.id}
                    className={managingSpaces ? 'space-row' : undefined}
                  >
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

                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setManagingSpaces(false);
                      onOpenSpaceSettings();
                    }}
                  >
                    <span className="tick" />
                    {currentUserName || 'Space'} settings…
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setManagingSpaces(false);
                      onOpenGlobalSettings();
                    }}
                  >
                    <span className="tick" />
                    Global settings…
                  </button>
                </li>
                <li role="none">
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
                <li role="none">
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
                    <li role="none">
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
  );
}
