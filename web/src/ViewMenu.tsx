import { formatShortcut } from './shortcuts';

/**
 * How far the sheet's text can be scaled, and in what steps.
 *
 * The floor is where the answer column stops being readable beside the text;
 * the ceiling is where a sheet of any length stops fitting on a laptop screen.
 */
export const MIN_FONT_SIZE = 13;
export const MAX_FONT_SIZE = 26;
export const FONT_STEP = 1;
export const DEFAULT_FONT_SIZE = 18;

/**
 * The decimal places offered, exactly as Soulver's Precision submenu lists
 * them. Six is deliberately absent — it is not one of Soulver's choices, which
 * is what settled the default being ten rather than what this used to do.
 */
export const PRECISIONS = [0, 1, 2, 3, 4, 5, 10, 15] as const;

export interface ViewMenuProps {
  open: boolean;
  fontSize: number;
  precision: number;
  thousandsSeparators: boolean;
  currencyRounding: boolean;
  onPrecision(next: number): void;
  onToggleSeparators(): void;
  onToggleCurrencyRounding(): void;
  sidebarOpen: boolean;
  showLineNumbers: boolean;
  showTotal: boolean;
  countReferenced: boolean;
  countVariables: boolean;
  largeNumberNotation: boolean;
  onFontSize(next: number): void;
  onToggleSidebar(): void;
  onToggleLineNumbers(): void;
  onToggleTotal(): void;
  onToggleReferenced(): void;
  onToggleVariables(): void;
  onToggleNotation(): void;
  onClose(): void;
}

/** A menu row that is on or off, with the tick in the same gutter throughout. */
function Check({
  on,
  label,
  hint,
  onClick,
}: {
  on: boolean;
  label: string;
  hint?: string;
  onClick(): void;
}) {
  return (
    <li>
      <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onClick}>
        <span className="tick">{on ? '✓' : ''}</span>
        <span className="view-label">{label}</span>
        {hint && <span className="view-hint">{hint}</span>}
      </button>
    </li>
  );
}

/**
 * Everything about how a sheet is shown, in one place.
 *
 * Modelled on Soulver's View menu, which is where it keeps the same set: text
 * size, the sidebar, line numbers, the total, and the total's options. The
 * toolbar used to carry two of these as bare glyphs — `300k` and `+x=` — which
 * gave a preference you set once the prominence of an action you take often,
 * and gave it no room to say what it did.
 *
 * Total Options is a section here rather than the submenu macOS gives Soulver.
 * A submenu that opens sideways is a fiddly thing to hit in a browser, and the
 * whole menu is only a dozen rows; indenting the group keeps the relationship
 * without the machinery.
 */
export function ViewMenu(props: ViewMenuProps) {
  const { open, fontSize, onClose } = props;
  if (!open) return null;

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <ul className="answer-menu view-menu" role="menu" aria-label="View">
        <li>
          <button
            type="button"
            role="menuitem"
            disabled={fontSize >= MAX_FONT_SIZE}
            onClick={() => props.onFontSize(fontSize + FONT_STEP)}
          >
            <span className="tick" />
            <span className="view-label">Bigger text</span>
            <span className="view-hint">{formatShortcut(['Mod', '+'])}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            role="menuitem"
            disabled={fontSize <= MIN_FONT_SIZE}
            onClick={() => props.onFontSize(fontSize - FONT_STEP)}
          >
            <span className="tick" />
            <span className="view-label">Smaller text</span>
            <span className="view-hint">{formatShortcut(['Mod', '−'])}</span>
          </button>
        </li>
        {fontSize !== DEFAULT_FONT_SIZE && (
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() => props.onFontSize(DEFAULT_FONT_SIZE)}
            >
              <span className="tick" />
              <span className="view-label">Reset text size</span>
              <span className="view-hint">{fontSize}px</span>
            </button>
          </li>
        )}

        <li className="menu-separator" role="separator" />

        <Check
          on={props.sidebarOpen}
          label="Sidebar"
          onClick={props.onToggleSidebar}
        />
        <Check
          on={props.showLineNumbers}
          label="Line numbers"
          onClick={props.onToggleLineNumbers}
        />

        <li className="menu-separator" role="separator" />

        <Check on={props.showTotal} label="Total" onClick={props.onToggleTotal} />

        <li className="view-group" role="presentation">
          Total options
        </li>
        <Check
          on={props.countReferenced}
          label="Include referenced lines"
          onClick={props.onToggleReferenced}
        />
        <Check
          on={props.countVariables}
          label="Include variable declaration lines"
          onClick={props.onToggleVariables}
        />

        <li className="menu-separator" role="separator" />

        <li className="view-group" role="presentation">
          Number format
        </li>
        <li className="view-precision">
          {/* The same empty gutter the ticked rows carry, so this label lines
              up with theirs instead of starting where their ticks do. */}
          <span className="tick" />
          <span className="view-label">Precision</span>
          <span className="precision-choices" role="group" aria-label="Decimal places">
            {PRECISIONS.map((places) => (
              <button
                key={places}
                type="button"
                className={places === props.precision ? 'picked' : undefined}
                aria-pressed={places === props.precision}
                title={`${places} decimal places`}
                onClick={() => props.onPrecision(places)}
              >
                {places}
              </button>
            ))}
          </span>
        </li>
        <Check
          on={props.thousandsSeparators}
          label="Thousands separators"
          hint={props.thousandsSeparators ? '1,234' : '1234'}
          onClick={props.onToggleSeparators}
        />
        <Check
          on={props.largeNumberNotation}
          label="Notation for large numbers"
          hint={props.largeNumberNotation ? '300k' : '300,000'}
          onClick={props.onToggleNotation}
        />
        <Check
          on={props.currencyRounding}
          label="Currency rounding"
          hint={props.currencyRounding ? '$3.33' : '$3.3333333333'}
          onClick={props.onToggleCurrencyRounding}
        />
      </ul>
    </>
  );
}
