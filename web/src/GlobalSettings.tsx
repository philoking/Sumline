import { GlobalsEditor, useRows } from './GlobalsEditor';
import { REGIONS, SettingField, regionLabel } from './SettingField';
import { useDialog } from './useDialog';
import { Backdrop } from './Popover';
import type { Computed } from './api';

export interface GlobalSettingsProps {
  open: boolean;
  /** The settings that apply across the whole instance. */
  computed: Computed;
  /** The variables that apply in every space. */
  globals: Record<string, string>;
  /** Shows what an expression works out to, for the preview beside each row. */
  preview(expression: string): string;
  onSaveComputed(key: keyof Computed, value: string | null): void;
  onSaveGlobals(globals: Record<string, string>): void;
  onClose(): void;
}

/**
 * What is true of the whole instance, in one place of its own.
 *
 * These used to sit inside the space panel, which was the wrong home for them
 * twice over: it put instance-wide controls behind a per-space door, and it made
 * every setting appear twice — once for the space and once for everywhere — so a
 * panel about one space was mostly about something else.
 *
 * Now a space's panel holds only that space, and this holds only what every
 * space starts from. Which door you opened tells you what you are editing.
 */
export function GlobalSettings(props: GlobalSettingsProps) {
  const { open, computed, globals, preview, onSaveComputed, onSaveGlobals, onClose } = props;
  const [rows, setRows] = useRows(globals, open);
  const panelRef = useDialog<HTMLElement>(open, onClose);

  if (!open) return null;

  return (
    <>
      <Backdrop onClose={onClose} />
      <aside
        className="reference space-settings"
        role="dialog"
        aria-label="Global settings"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="reference-head">
          <strong>Global settings</strong>
          <button type="button" className="ghost" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="reference-body">
          <p className="reference-blurb">
            In effect in <strong>every</strong> space. Any space can differ by
            setting its own, which leaves the others as they were.
          </p>

          <SettingField
            autoFocus
            label="Number region"
            blurb={
              <>
                Which convention sheets are written in. It decides how a sheet is{' '}
                <strong>read</strong>, not just how answers look:{' '}
                <code>1.234 + 1</code> is 1.235 under Western Europe and 2.234
                under North America.
              </>
            }
            value={computed.region}
            inheritLabel={`Not set — ${regionLabel(undefined)}`}
            options={REGIONS}
            onSave={(value) => onSaveComputed('region', value)}
          />

          <SettingField
            label="Time zone"
            blurb="Where dates resolve. Left empty they resolve wherever the reader is, which suits an instance whose readers are in one place or several."
            value={computed.zone}
            inheritLabel="Not set — the reader’s own"
            onSave={(value) => onSaveComputed('zone', value)}
          />

          <section className="reference-group">
            <h3>Variables</h3>
            <p className="reference-blurb">
              Available to every sheet in every space, as if each had declared
              them at the top. A space can override one by name, and a sheet can
              shadow it by declaring the same name itself.
            </p>
            <GlobalsEditor
              rows={rows}
              setRows={setRows}
              stored={globals}
              preview={preview}
              onSave={onSaveGlobals}
            />
          </section>

          <section className="reference-group">
            <p className="reference-note">
              There are no passwords unless <code>WEBCALC_PASSWORD</code> is set,
              so anyone who can open the app can change what is on this panel.
            </p>
          </section>
        </div>
      </aside>
    </>
  );
}
