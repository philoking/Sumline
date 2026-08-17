import { useEffect, useState } from 'react';
import { GlobalsEditor, named, useRows } from './GlobalsEditor';
import { REGIONS, SettingField, regionLabel } from './SettingField';
import { useDialog } from './useDialog';
import type { Computed, User } from './api';

export interface SpaceSettingsProps {
  open: boolean;
  /** The space being edited — always the one in use; see below. */
  space: User;
  /** This space's own globals. */
  globals: Record<string, string>;
  /** The globals that apply in every space, listed here as still in effect. */
  sharedGlobals: Record<string, string>;
  /** False when this is the only space, which cannot be removed. */
  canRemove: boolean;
  /** This space's own settings. A missing key means it follows the global one. */
  computed: Computed;
  /** The global tier, shown so an inherited value can be named rather than implied. */
  sharedComputed: Computed;
  /** Shows what an expression works out to, for the preview beside each row. */
  preview(expression: string): string;
  onRename(name: string): void;
  onSaveGlobals(globals: Record<string, string>): void;
  /** Sets one of this space's own values. `null` clears it back to inheriting. */
  onSaveComputed(key: keyof Computed, value: string | null): void;
  onRemove(): void;
  onClose(): void;
}

export function SpaceSettings(props: SpaceSettingsProps) {
  const { open, space, globals, sharedGlobals, canRemove, preview } = props;
  const { computed, sharedComputed } = props;
  const { onRename, onSaveGlobals, onSaveComputed, onRemove, onClose } = props;

  const [name, setName] = useState(space.name);
  const [spaceRows, setSpaceRows] = useRows(globals, open);
  const panelRef = useDialog<HTMLElement>(open, onClose);

  useEffect(() => {
    if (open) setName(space.name);
  }, [open, space.name]);

  if (!open) return null;

  const ownNames = new Set(named(spaceRows).map((row) => row.name.trim()));
  const shadowing: Record<string, string> = {};
  for (const [key, value] of Object.entries(sharedGlobals)) {
    if (ownNames.has(key)) shadowing[key] = value;
  }
  const inherited = Object.entries(sharedGlobals).filter(([key]) => !ownNames.has(key));

  const commitName = () => {
    const next = name.trim();
    if (next === '' || next === space.name) {
      setName(space.name);
      return;
    }
    onRename(next);
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <aside
        className="reference space-settings"
        role="dialog"
        aria-label={`${space.name} settings`}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="reference-head">
          <strong>{space.name}</strong>
          <button type="button" className="ghost" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="reference-body">
          <section className="reference-group">
            <h3>Name</h3>
            <input
              className="space-name-input"
              data-autofocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setName(space.name);
              }}
              aria-label="Space name"
            />
            <p className="reference-note">
              Renaming changes only what is shown. Every sheet stays where it is,
              because they are filed under this space’s id (<code>{space.id}</code>),
              not its name.
            </p>
          </section>

          {/* Only this space's own values. What every space starts from lives in
              Global settings — a panel about one space should not be mostly
              about the instance. */}
          <SettingField
            label="Number region"
            blurb={
              <>
                Only for {space.name}. It decides how a sheet is{' '}
                <strong>read</strong>: <code>1.234 + 1</code> is 1.235 under
                Western Europe and 2.234 under North America.
              </>
            }
            value={computed.region}
            inheritLabel={`Global — ${regionLabel(sharedComputed.region)}`}
            options={REGIONS}
            onSave={(value) => onSaveComputed('region', value)}
          />

          <SettingField
            label="Time zone"
            blurb={`Only for ${space.name}. Where its dates resolve.`}
            value={computed.zone}
            inheritLabel={
              sharedComputed.zone
                ? `Global — ${sharedComputed.zone}`
                : 'Global — the reader’s own'
            }
            onSave={(value) => onSaveComputed('zone', value)}
          />

          <section className="reference-group">
            <h3>Variables</h3>
            <p className="reference-blurb">
              Available to every sheet in {space.name}, as if each had declared
              them at the top. A sheet can shadow one by declaring the same name.
            </p>

            <GlobalsEditor
              rows={spaceRows}
              setRows={setSpaceRows}
              stored={globals}
              preview={preview}
              onSave={onSaveGlobals}
              shadowing={shadowing}
            />

            {inherited.length > 0 && (
              <>
                <p className="reference-note">Also in effect here, from Global settings:</p>
                <div className="globals-editor">
                  {inherited.map(([key, value]) => (
                    <div className="global-row global-row-inherited" key={key}>
                      <span className="global-inherited-name">{key}</span>
                      <span className="global-inherited-value">{value}</span>
                      <span className="global-answer" title={preview(value)}>
                        {preview(value) || '—'}
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        title={`Give ${space.name} its own ${key}`}
                        onClick={() =>
                          setSpaceRows((current) => [...current, { name: key, value }])
                        }
                      >
                        Override
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="reference-group">
            <h3>Remove</h3>
            <p className="reference-blurb">
              Removing <strong>{space.name}</strong> keeps its sheets. Nothing owns
              them afterwards so they drop out of every list, and adding a space back
              under the same name shows them again.
            </p>
            <button
              type="button"
              className="danger-button"
              disabled={!canRemove}
              onClick={onRemove}
              title={
                canRemove ? `Remove ${space.name}` : 'The last space cannot be removed'
              }
            >
              Remove this space
            </button>
          </section>
        </div>
      </aside>
    </>
  );
}
